"""Risk services: methodology versions, assessments (rules of record + challenger), overrides, EDD triggers,
disagreement review, and the model registry with promotion and drift."""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from django.db import transaction
from django.utils import timezone

from graph.common import as_uuid, audit, publish, system_actor, user_names
from kinroot.contracts import (
    Actor,
    ChallengerView,
    DomainConflict,
    EddTrigger,
    MatchReason,
    NotFound,
    Page,
    RiskAssessmentView,
    RiskReason,
)
from resolution.ml.common import psi_status

from . import challenger as challenger_rt
from . import features as feat
from . import rules as rules_engine
from .models import Disagreement, ModelPromotion, RiskAssessment, RiskMethodology

log = logging.getLogger(__name__)
MAX_EVIDENCE = 20
MIN_DRIFT_SAMPLE = 50


# ── Methodology ───────────────────────────────────────────────────────────────────────────────────
def seed_methodologies(org_id: Any) -> int:
    created = 0
    for m in rules_engine.default_methodologies():
        _, made = RiskMethodology.objects.get_or_create(
            org_id=org_id,
            version=m["version"],
            defaults={
                "status": m["status"],
                "bands": m["bands"],
                "rules": m["rules"],
                "published_at": timezone.now() if m["status"] == "published" else None,
            },
        )
        created += int(made)
    return created


def published(org_id: Any) -> RiskMethodology:
    m = (
        RiskMethodology.objects.filter(org_id=org_id, status="published")
        .order_by("-published_at", "-created_at")
        .first()
    )
    if m is None:
        seed_methodologies(org_id)
        m = RiskMethodology.objects.filter(org_id=org_id, status="published").first()
    assert m is not None
    return m


def _methodology_dict(m: RiskMethodology, names: dict[str, str]) -> dict[str, Any]:
    return {
        "id": str(m.id),
        "version": m.version,
        "status": m.status,
        "publishedAt": m.published_at.isoformat() if m.published_at else None,
        "publishedBy": names.get(str(m.published_by_id))
        if m.published_by_id
        else ("System" if m.published_at else None),
        "bands": m.bands,
        "rules": [
            {
                "code": r["code"],
                "factor": r["factor"],
                "description": r["description"],
                "points": r["points"],
                "condition": r["condition"],
                "floor": r.get("floor"),
            }
            for r in m.rules
        ],
    }


def methodology_versions(org_id: Any) -> list[dict[str, Any]]:
    if not RiskMethodology.objects.filter(org_id=org_id).exists():
        seed_methodologies(org_id)
    items = list(RiskMethodology.objects.filter(org_id=org_id).order_by("-version"))
    names = user_names({m.published_by_id for m in items})
    return [_methodology_dict(m, names) for m in items]


def publish_methodology(org_id: Any, methodology_id: Any, actor: Actor) -> dict[str, Any]:
    with transaction.atomic():
        m = RiskMethodology.objects.select_for_update().filter(org_id=org_id, id=as_uuid(methodology_id)).first()
        if m is None:
            raise NotFound("methodology")
        if m.status != "draft":
            raise DomainConflict("conflict", "Only a draft methodology can be published.")
        RiskMethodology.objects.filter(org_id=org_id, status="published").update(status="retired")
        m.status = "published"
        m.published_by_id = actor.user_id
        m.published_at = timezone.now()
        m.save(update_fields=["status", "published_by", "published_at"])
        audit(
            actor,
            "risk.methodology_published",
            resource_type="methodology",
            resource_id=m.id,
            metadata={"version": m.version},
        )
    return _methodology_dict(m, user_names({m.published_by_id}))


# ── Assessment ────────────────────────────────────────────────────────────────────────────────────
def _screening_flags(org_id: Any, client: Any, party_ids: list[str]) -> dict[str, bool]:
    from screening.models import ScreeningHit

    hits = ScreeningHit.objects.filter(org_id=org_id, party_id__in=party_ids)
    return {
        "pep_client": hits.filter(party_id=client.party_id, list_kind="pep", status="true_match").exists(),
        "sanctions_possible": hits.filter(list_kind="sanctions", status__in=["pending", "escalated"]).exists(),
        "sanctions_confirmed": hits.filter(list_kind="sanctions", status="true_match").exists(),
    }


def _home_country(org_id: Any) -> str:
    from accounts.models import Organisation

    org = Organisation.objects.filter(id=org_id).only("country").first()
    return (org.country if org else "AU") or "AU"


def _structure_extras(org_id: Any, bundle: Any) -> dict[str, Any]:
    """Rule-only structure facts (not challenger inputs): undisclosed holders, offshore subsidiaries, officer
    changes. Evidence ids are added to the bundle so the reasons can cite them."""
    from datetime import timedelta

    from graph.jurisdictions import is_offshore
    from graph.ownership import OFFICER_ROLES

    st = bundle.structure
    sub, repo, as_of = st.sub, st.repo, st.as_of
    undisclosed = [n for n in sub.nodes.values() if n.kind == "other" and sub.out_edges(n.id, "ownership")]
    down = repo.downstream([st.party_id], as_of, depth=3)
    offshore = [
        n
        for n in down.nodes.values()
        if n.id != st.party_id and n.kind not in ("person", "address") and is_offshore(n.jurisdiction)
    ]
    since = as_of - timedelta(days=365)
    officer_changes = []
    for e in repo.edges_any_time([st.party_id]):
        if e.kind != "control" or e.role not in OFFICER_ROLES or e.dst != st.party_id:
            continue
        for d in (e.valid_from, e.valid_to):
            if d and not d.startswith("0000") and since.isoformat() < d[:10] <= as_of.isoformat():
                officer_changes.append(e)
                break
    bundle.evidence.setdefault("unexplained_pct", []).extend({"type": "node", "id": n.id} for n in undisclosed)
    bundle.evidence["offshore_subsidiaries"] = [{"type": "node", "id": n.id} for n in offshore]
    bundle.evidence["recent_officer_changes_12m"] = [{"type": "edge", "id": e.id} for e in officer_changes]
    return {
        "undisclosed_holders": len(undisclosed),
        "offshore_subsidiaries": len(offshore),
        "recent_officer_changes_12m": len(officer_changes),
    }


def compute(org_id: Any, client: Any) -> dict[str, Any]:
    """Everything an assessment needs, without persisting (also used by the assistant and the eval)."""
    from graph import service as graph

    bundle = graph.feature_bundle(org_id, client.id)
    party_ids = list(bundle.structure.sub.nodes)
    flags = _screening_flags(org_id, client, party_ids)
    f = feat.build(client, bundle.features, home_country=_home_country(org_id), screening=flags)
    f.update(_structure_extras(org_id, bundle))
    m = published(org_id)
    res = rules_engine.apply({"rules": m.rules, "bands": m.bands}, f)
    reasons = [
        RiskReason(
            code=h.code,
            factor=h.factor,  # type: ignore[arg-type]
            points=h.points,
            message=h.message,
            evidence=(bundle.evidence.get(h.evidence_key or "", []) if h.evidence_key else [])[:MAX_EVIDENCE],
        )
        for h in res.hits
    ]
    triggers = feat.edd_triggers(f, res.rating)
    try:
        ch = challenger_rt.score(f, res.rating)
        floored = any(h.floor and h.floor == res.rating for h in res.hits)
        if floored and ch["agreement"] == "disagree":
            # a mandatory floor (PEP client, confirmed sanctions) fixes the rating: nothing for the queue to decide
            ch["agreement"] = "agree"
            ch["floor_applied"] = True
    except FileNotFoundError:
        ch = None
    return {
        "features": f,
        "methodology": m,
        "result": res,
        "reasons": reasons,
        "triggers": triggers,
        "challenger": ch,
        "bundle": bundle,
    }


def _view(a: RiskAssessment, names: dict[str, str] | None = None) -> RiskAssessmentView:
    ch = None
    if a.challenger:
        c = a.challenger
        dis = Disagreement.objects.filter(assessment=a).values_list("id", flat=True).first()
        ch = ChallengerView(
            model_version=c["model_version"],
            probability_high=c["probability_high"],
            rating=c["rating"],
            agreement=c["agreement"],
            reasons=[MatchReason(**r) for r in c["reasons"]],
            disagreement_id=str(dis) if dis else None,
        )
    return RiskAssessmentView(
        id=str(a.id),
        client_id=str(a.client_id),
        methodology_version=a.methodology.version,
        score=a.score,
        rating=a.rating,  # type: ignore[arg-type]
        reasons=[RiskReason(**r) for r in a.reasons],
        challenger=ch,
        edd_required=bool(a.edd_triggers),
        edd_triggers=[EddTrigger(**t) for t in a.edd_triggers],
        inputs_hash=a.inputs_hash,
        assessed_at=a.created_at,
        override=a.override,
    )


def _client(org_id: Any, client_id: Any) -> Any:
    from clients.models import Client

    c = Client.objects.filter(org_id=org_id, id=as_uuid(client_id)).first()
    if c is None:
        raise NotFound("client")
    return c


def latest_row(org_id: Any, client_id: Any) -> RiskAssessment | None:
    return (
        RiskAssessment.objects.filter(org_id=org_id, client_id=client_id)
        .select_related("methodology")
        .order_by("-created_at", "-id")
        .first()
    )


def assess_client(org_id: Any, client_id: Any, actor: Actor) -> RiskAssessmentView:
    from clients import api as clients

    client = _client(org_id, client_id)
    c = compute(org_id, client)
    res, m, ch = c["result"], c["methodology"], c["challenger"]
    ihash = feat.inputs_hash(c["features"], m.version, ch["model_version"] if ch else None)
    prev = latest_row(org_id, client.id)
    if prev is not None and prev.inputs_hash == ihash and prev.override is None:
        return _view(prev)  # identical inputs: the assessment stands (deterministic, no duplicate rows)
    challenger_json = None
    if ch is not None:
        challenger_json = {**ch, "reasons": [r.__dict__ for r in ch["reasons"]]}
    with transaction.atomic():
        a = RiskAssessment.objects.create(
            org_id=org_id,
            client=client,
            methodology=m,
            score=res.score,
            rating=res.rating,
            reasons=[r.__dict__ for r in c["reasons"]],
            features=c["features"],
            challenger=challenger_json,
            edd_triggers=c["triggers"],
            inputs_hash=ihash,
            assessed_by_id=actor.user_id,
        )
        if ch is not None and ch["agreement"] == "disagree":
            Disagreement.objects.filter(org_id=org_id, client=client, status="open").update(
                status="resolved",
                outcome="keep_rules",
                note="Superseded by a newer assessment",
                resolved_at=timezone.now(),
            )
            Disagreement.objects.create(
                org_id=org_id,
                client=client,
                assessment=a,
                rules_rating=res.rating,
                challenger_rating=ch["rating"],
                probability_high=ch["probability_high"],
                reasons=challenger_json["reasons"] if challenger_json else [],
            )
        clients.set_client_rating(
            as_uuid(org_id),
            client.id,
            res.rating,
            timezone.localdate(),
            source="rules",
            edd_triggers=[EddTrigger(**t) for t in c["triggers"]],
        )
        audit(
            actor,
            "risk.assessed",
            resource_type="client",
            resource_id=client.id,
            metadata={
                "rating": res.rating,
                "score": res.score,
                "methodology": m.version,
                "agreement": ch["agreement"] if ch else None,
            },
        )
    publish(
        org_id,
        "risk.assessed",
        {"clientId": str(client.id), "rating": res.rating, "agreement": ch["agreement"] if ch else None},
        permission="risk:read",
    )
    if prev is not None and (prev.override or {}).get("rating", prev.rating) != res.rating:
        try:
            from monitoring.service import raise_alert

            raise_alert(
                org_id,
                client.id,
                "risk_change",
                "warning" if res.rating == "high" else "info",
                f"Risk rating changed from {prev.rating} to {res.rating}",
                "The rules methodology gave a different rating after the client's information or structure changed.",
                [{"type": "node", "id": str(client.party_id)}],
                dedupe_key=f"risk_change:{a.id}",
            )
        except Exception:
            log.exception("risk change alert failed")
    return _view(a)


def assess_org(org_id: Any, actor: Actor) -> int:
    from clients.models import Client

    n = 0
    for c in Client.objects.filter(org_id=org_id, status__in=["active", "blocked", "onboarding"]).order_by("name"):
        if c.status == "onboarding" and not c.submitted_at:
            continue
        try:
            assess_client(org_id, c.id, actor)
            n += 1
        except Exception:
            log.exception("assessment failed for client %s", c.id)
    return n


def latest_assessment(org_id: Any, client_id: Any) -> RiskAssessmentView | None:
    _client(org_id, client_id)
    a = latest_row(org_id, client_id)
    return _view(a) if a else None


def assessment_history(org_id: Any, client_id: Any) -> list[RiskAssessmentView]:
    _client(org_id, client_id)
    return [
        _view(a)
        for a in RiskAssessment.objects.filter(org_id=org_id, client_id=client_id)
        .select_related("methodology")
        .order_by("-created_at", "-id")
    ]


def override_rating(org_id: Any, client_id: Any, rating: str, reason: str, actor: Actor) -> RiskAssessmentView:
    from clients import api as clients

    if rating not in rules_engine.RATING_ORDER:
        raise ValueError("rating must be low, medium or high")
    client = _client(org_id, client_id)
    prev = latest_row(org_id, client.id)
    if prev is None:
        assess_client(org_id, client.id, actor)
        prev = latest_row(org_id, client.id)
    assert prev is not None
    reason = (reason or "").strip()
    lowering = rules_engine.RATING_ORDER[rating] < rules_engine.RATING_ORDER[prev.rating]
    if lowering and len(reason) < 20:
        raise ValueError("Lowering a rating needs a reason of at least 20 characters.")
    if len(reason) < 5:
        raise ValueError("Give a reason for the override.")
    triggers = list(prev.edd_triggers)
    if rating == "high" and not any(t["code"] == "high_rating" for t in triggers):
        triggers.append(
            {
                "code": "high_rating",
                "message": feat.TRIGGERS["high_rating"][0],
                "measures": feat.TRIGGERS["high_rating"][1],
            }
        )
    if rating != "high":
        triggers = [t for t in triggers if t["code"] != "high_rating"]
    with transaction.atomic():
        a = RiskAssessment.objects.create(
            org_id=org_id,
            client=client,
            methodology=prev.methodology,
            score=prev.score,
            rating=prev.rating,
            reasons=prev.reasons,
            features=prev.features,
            challenger=prev.challenger,
            edd_triggers=triggers,
            inputs_hash=prev.inputs_hash,
            override={"rating": rating, "reason": reason, "byName": actor.name, "at": timezone.now().isoformat()},
            assessed_by_id=actor.user_id,
        )
        clients.set_client_rating(
            as_uuid(org_id),
            client.id,
            rating,
            timezone.localdate(),
            source="override",
            edd_triggers=[EddTrigger(**t) for t in triggers],
        )
        audit(
            actor,
            "risk.overridden",
            resource_type="client",
            resource_id=client.id,
            metadata={"from": prev.rating, "to": rating, "lowered": lowering},
        )
    publish(
        org_id,
        "risk.assessed",
        {"clientId": str(client.id), "rating": rating, "agreement": None},
        permission="risk:read",
    )
    return _view(a)


def edd_requirements(org_id: Any, client_id: Any) -> list[EddTrigger]:
    _client(org_id, client_id)
    a = latest_row(org_id, client_id)
    return [EddTrigger(**t) for t in a.edd_triggers] if a else []


# ── Disagreements ─────────────────────────────────────────────────────────────────────────────────
def _dis_dict(d: Disagreement, names: dict[str, str]) -> dict[str, Any]:
    return {
        "id": str(d.id),
        "clientId": str(d.client_id),
        "clientName": d.client.name,
        "assessmentId": str(d.assessment_id),
        "rulesRating": d.rules_rating,
        "challengerRating": d.challenger_rating,
        "probabilityHigh": d.probability_high,
        "reasons": d.reasons,
        "status": d.status,
        "outcome": d.outcome or None,
        "note": d.note or None,
        "resolvedBy": names.get(str(d.resolved_by_id)) if d.resolved_by_id else None,
        "resolvedAt": d.resolved_at.isoformat() if d.resolved_at else None,
        "createdAt": d.created_at.isoformat(),
    }


def list_disagreements(org_id: Any, *, status: str | None = "open", offset: int = 0, limit: int = 25) -> Page[dict]:
    qs = Disagreement.objects.filter(org_id=org_id).select_related("client")
    if status:
        qs = qs.filter(status=status)
    qs = qs.order_by("-probability_high", "-created_at")
    total = qs.count()
    items = list(qs[offset : offset + limit])
    names = user_names({d.resolved_by_id for d in items})
    return Page(items=[_dis_dict(d, names) for d in items], total=total)


def resolve_disagreement(org_id: Any, disagreement_id: Any, outcome: str, note: str, actor: Actor) -> dict[str, Any]:
    if outcome not in ("keep_rules", "override_to_challenger", "methodology_issue"):
        raise ValueError("outcome must be keep_rules, override_to_challenger or methodology_issue")
    with transaction.atomic():
        d = (
            Disagreement.objects.select_for_update()
            .select_related("client")
            .filter(org_id=org_id, id=as_uuid(disagreement_id))
            .first()
        )
        if d is None:
            raise NotFound("disagreement")
        if d.status != "open":
            raise DomainConflict("already_decided", "This disagreement has already been resolved.")
        if outcome == "override_to_challenger":
            override_rating(
                org_id, d.client_id, d.challenger_rating, note or "Second-opinion check accepted after review", actor
            )
        d.status, d.outcome, d.note = "resolved", outcome, (note or "").strip()
        d.resolved_by_id, d.resolved_at = actor.user_id, timezone.now()
        d.save(update_fields=["status", "outcome", "note", "resolved_by", "resolved_at"])
        audit(
            actor,
            "risk.disagreement_resolved",
            resource_type="client",
            resource_id=d.client_id,
            metadata={"outcome": outcome},
        )
    return _dis_dict(d, user_names({d.resolved_by_id}))


# ── Model registry ────────────────────────────────────────────────────────────────────────────────
MODELS = ("er-matcher", "risk-challenger")


def _manifest(name: str) -> tuple[dict[str, Any], Path]:
    if name == "er-matcher":
        from resolution import model as er_model

        return er_model.manifest(), er_model.model_dir()
    return challenger_rt.manifest(), challenger_rt.model_dir()


def _run_id(name: str, version: str) -> str | None:
    try:
        from graph.common import kinroot_setting

        uri = str(kinroot_setting("MLFLOW_TRACKING_URI"))
        if uri.startswith("sqlite:///") and not Path(uri.removeprefix("sqlite:///")).exists():
            return None
        from mlflow import MlflowClient

        client = MlflowClient(tracking_uri=uri)
        found = client.search_model_versions(
            f"name='{name}' and tag.kinroot_version='{version}'", order_by=["version_number DESC"], max_results=1
        )
        return found[0].run_id if found else None
    except Exception:
        return None


def drift(name: str = "risk-challenger") -> dict[str, Any]:
    """PSI of current inputs and scores (latest assessment per client, all firms) against the training reference."""
    if name != "risk-challenger":
        return {"psi": 0.0, "status": "stable", "features": {}, "n": 0}
    path = challenger_rt.model_dir() / "drift_reference.json"
    if not path.exists():
        return {"psi": 0.0, "status": "stable", "features": {}, "n": 0}
    ref = json.loads(path.read_text())
    latest: dict[str, RiskAssessment] = {}
    for a in RiskAssessment.objects.filter(override__isnull=True).order_by("client_id", "-created_at"):
        latest.setdefault(str(a.client_id), a)
    rows = [a for a in latest.values() if a.challenger]
    if len(rows) < MIN_DRIFT_SAMPLE:
        return {
            "psi": None,
            "status": "stable",
            "features": {},
            "n": len(rows),
            "note": f"drift is measured once {MIN_DRIFT_SAMPLE} clients are assessed",
        }
    per = {
        f: round(_psi_ref(spec, [float(a.features.get(f, 0) or 0) for a in rows]), 4)
        for f, spec in ref["features"].items()
    }
    score = round(_psi_ref(ref["score"], [float((a.challenger or {})["probability_high"]) for a in rows]), 4)
    worst = max([score, *per.values()])
    return {
        "psi": score,
        "maxFeaturePsi": max(per.values()),
        "status": psi_status(worst),
        "features": per,
        "n": len(rows),
    }


def _psi_ref(spec: dict[str, list[float]], values: list[float]) -> float:
    import numpy as np

    edges = spec["edges"]
    expected = np.clip(np.array(spec["expected"], float), 1e-4, None)
    actual = np.histogram(np.asarray(values, float), bins=edges)[0].astype(float)
    actual = np.clip(actual / max(actual.sum(), 1.0), 1e-4, None)
    return float(np.sum((actual - expected) * np.log(actual / expected)))


def model_registry() -> list[dict[str, Any]]:
    out = []
    for name in MODELS:
        try:
            man, d = _manifest(name)
        except FileNotFoundError:
            continue
        promos = list(ModelPromotion.objects.filter(model_name=name).order_by("-id"))
        champion = promos[0].version if promos and promos[0].version in man["versions"] else man["champion"]
        last_promo = {p.version: p for p in reversed(promos)}
        dr = drift(name)
        card = (d / "model_card.md").read_text() if (d / "model_card.md").exists() else ""
        versions = []
        for v, spec in man["versions"].items():
            model_file = d / spec["model"]
            trained = (
                datetime.fromtimestamp(model_file.stat().st_mtime, tz=UTC).isoformat() if model_file.exists() else None
            )
            p = last_promo.get(v)
            stage = "champion" if v == champion else ("retired" if p is not None else "challenger")
            m = spec.get("metrics", {})
            versions.append(
                {
                    "version": v,
                    "stage": stage,
                    "kind": spec["kind"],
                    "trainedAt": trained,
                    "metrics": m,
                    "calibration": {"brier": m.get("brier"), "ece": m.get("ece")},
                    "drift": {"psi": dr["psi"], "status": dr["status"]}
                    if v == champion
                    else {"psi": None, "status": "stable"},
                    "modelCard": card,
                    "runId": _run_id(name, v),
                    "promotedBy": p.promoted_by_name if p else None,
                    "promotedAt": p.created_at.isoformat() if p else None,
                }
            )
        versions.sort(key=lambda x: (x["stage"] != "champion", x["version"]))
        out.append({"name": name, "versions": versions})
    return out


def promote_model(model_name: str, version: str, actor: Actor, note: str) -> dict[str, Any]:
    if model_name not in MODELS:
        raise NotFound("model")
    man, _ = _manifest(model_name)
    if version not in man["versions"]:
        raise NotFound("model version")
    if len((note or "").strip()) < 10:
        raise ValueError("Record why this version is promoted (at least 10 characters).")
    current = next(v for v in model_registry() if v["name"] == model_name)
    if any(v["version"] == version and v["stage"] == "champion" for v in current["versions"]):
        raise DomainConflict("conflict", "This version is already in use.")
    ModelPromotion.objects.create(
        model_name=model_name,
        version=version,
        stage="champion",
        org_id=actor.org_id,
        promoted_by_id=actor.user_id,
        promoted_by_name=actor.name,
        note=note.strip(),
    )
    if model_name == "er-matcher":
        from resolution import model as er_model

        er_model.clear_cache()
    else:
        challenger_rt.clear_cache()
    audit(
        actor,
        "models.promoted",
        resource_type="model",
        resource_id=f"{model_name}:{version}",
        metadata={"note": note.strip()[:200]},
    )
    return next(v for v in model_registry() if v["name"] == model_name)


def system(org_id: Any) -> Actor:
    return system_actor(org_id)
