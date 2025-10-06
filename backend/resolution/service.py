"""Entity-resolution services: scoring, candidate generation, the merge/split queue."""

from __future__ import annotations

import logging
from datetime import timedelta
from typing import Any

from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from graph.common import as_uuid, audit, org_settings, publish, system_actor, user_names
from kinroot.contracts import (
    Actor,
    DomainConflict,
    MatchCandidateView,
    MatchReason,
    MatchScore,
    MergeOutcome,
    NotFound,
    Page,
    PartyRecord,
    Thresholds,
)

from . import model as er_model
from .blocking import candidate_pairs
from .features import compare, prepare
from .models import MatchCandidate, MergeRecord
from .reasons import reasons as to_reasons

log = logging.getLogger(__name__)
REJECT_FLOOR = 0.02  # reject-band pairs below this are not stored (obvious non-matches) ...
REJECT_NAME_SIMILARITY = 0.9  # ... unless the names look alike, so the "checked, not the same" decision is visible


def score_pair(left: PartyRecord, right: PartyRecord) -> MatchScore:
    feats = compare(left, right)
    s = er_model.score_features(feats)
    return MatchScore(
        probability=s["probability"],
        band=s["band"],
        fs_weight=s["fs_weight"],
        fs_probability=s["fs_probability"],
        features=feats,
        reasons=to_reasons(feats, s["contributions"]),
        model_version=s["model_version"],
    )


def thresholds(org_id: Any = None) -> Thresholds:
    m = er_model.load(org_id=org_id)
    t = m.thresholds
    return Thresholds(
        auto_merge=float(t["auto_merge"]),
        review=float(t["review"]),
        model_version=m.version,
        chosen_by=t["chosen_by"],
        expected_review_rate=float(t["expected_review_rate"]),
    )


# ── Candidates ────────────────────────────────────────────────────────────────────────────────────
def _ordered(a: str, b: str) -> tuple[str, str]:
    return (a, b) if a < b else (b, a)


def _store(
    org_id: Any,
    left_id: str,
    right_id: str,
    score: MatchScore,
    *,
    origin: str = "blocking",
    force_pending: bool = False,
) -> tuple[MatchCandidate, bool]:
    left_id, right_id = _ordered(left_id, right_id)
    existing = MatchCandidate.objects.filter(left_id=as_uuid(left_id), right_id=as_uuid(right_id)).first()
    fields = {
        "probability": score.probability,
        "band": score.band,
        "fs_weight": score.fs_weight,
        "fs_probability": score.fs_probability,
        "features": score.features,
        "reasons": [r.__dict__ for r in score.reasons],
        "model_version": score.model_version,
    }
    if existing is not None:
        if existing.status in ("pending", "deferred") or force_pending:
            for k, v in fields.items():
                setattr(existing, k, v)
            if force_pending and existing.status not in ("merged", "auto_merged"):
                existing.status = "pending"
                existing.origin = origin
            existing.save()
        return existing, False
    status = "pending"
    note = ""
    if score.band == "reject" and not force_pending:
        status, note = "not_match", "Below the review threshold"
    cand = MatchCandidate.objects.create(
        org_id=org_id, left_id=left_id, right_id=right_id, origin=origin, status=status, note=note, **fields
    )
    return cand, True


def _survivor(org_id: Any, a: str, b: str) -> tuple[str, str]:
    """Keep the record a client relies on, then the better connected one, then the older one."""
    from clients.models import Client, Party, Relationship

    parties = {str(p.id): p for p in Party.objects.filter(org_id=org_id, id__in=[a, b])}

    def rank(pid: str) -> tuple[int, int, Any]:
        is_client = Client.objects.filter(org_id=org_id, party_id=pid).exists()
        rels = Relationship.objects.filter(org_id=org_id).filter(Q(from_party_id=pid) | Q(to_party_id=pid)).count()
        return (0 if is_client else 1, -rels, parties[pid].created_at if pid in parties else timezone.now())

    survivor, merged = sorted([a, b], key=rank)
    return survivor, merged


def _merge(org_id: Any, cand: MatchCandidate, actor: Actor, status: str) -> MergeOutcome:
    from clients import api as clients

    survivor, merged = _survivor(org_id, str(cand.left_id), str(cand.right_id))
    clients.merge_parties(as_uuid(org_id), as_uuid(survivor), [as_uuid(merged)], actor)
    try:
        from screening.service import repoint_party

        repoint_party(org_id, merged, survivor)
    except Exception:
        log.exception("screening re-point after merge failed")
    cand.status = status
    cand.decided_by_id = actor.user_id
    cand.decided_at = timezone.now()
    cand.save(update_fields=["status", "decided_by", "decided_at", "note", "updated_at"])
    MergeRecord.objects.create(
        org_id=org_id,
        survivor_id=survivor,
        merged_id=merged,
        candidate=cand,
        actor_id=actor.user_id,
        actor_name=actor.name,
    )
    audit(
        actor,
        "resolution.auto_merged" if status == "auto_merged" else "resolution.merged",
        resource_type="party",
        resource_id=survivor,
        metadata={
            "candidateId": str(cand.id),
            "mergedIds": [merged],
            "probability": cand.probability,
            "modelVersion": cand.model_version,
        },
    )
    publish(org_id, "resolution.merged", {"survivorId": survivor, "mergedIds": [merged]}, permission="graph:read")
    return MergeOutcome(candidate_id=str(cand.id), survivor_id=survivor, merged_ids=[merged], status=status)  # type: ignore[arg-type]


def find_candidates(org_id: Any, *, party_ids: list[Any] | None = None) -> int:
    from clients import api as clients

    org_id = as_uuid(org_id)
    records = clients.party_records(org_id)
    if len(records) < 2:
        return 0
    prepared = [prepare(r) for r in records]
    touching = None
    if party_ids is not None:
        wanted = {str(p) for p in party_ids}
        touching = {i for i, r in enumerate(records) if r.id in wanted}
        if not touching:
            return 0
    pairs = sorted(candidate_pairs(prepared, only_touching=touching))
    auto_enabled = bool(org_settings(org_id).get("resolution", {}).get("auto_merge_enabled", True))
    actor = system_actor(org_id)
    merged_away: set[str] = set()
    changed = 0
    matcher = er_model.load(org_id=org_id)
    for i, j in pairs:
        a, b = records[i], records[j]
        if a.id in merged_away or b.id in merged_away:
            continue
        if a.kind != b.kind:
            continue  # a company is never the same party as a trust or a partnership
        feats = compare(prepared[i], prepared[j])
        s = er_model.score_features(feats, matcher)
        if (
            s["band"] == "reject"
            and s["probability"] < REJECT_FLOOR
            and feats["name_jaro_winkler"] < REJECT_NAME_SIMILARITY
        ):
            continue
        score = MatchScore(
            s["probability"],
            s["band"],
            s["fs_weight"],
            s["fs_probability"],
            feats,
            to_reasons(feats, s["contributions"]),
            s["model_version"],
        )
        with transaction.atomic():
            cand, created = _store(org_id, a.id, b.id, score)
            changed += 1
            if cand.status == "pending" and score.band == "auto_merge" and auto_enabled:
                cand.note = "Merged automatically: above the auto-merge threshold"
                outcome = _merge(org_id, cand, actor, "auto_merged")
                merged_away.update(outcome.merged_ids)
            elif created and cand.status == "pending":
                publish(
                    org_id,
                    "resolution.candidate",
                    {"candidateId": str(cand.id), "band": cand.band},
                    permission="resolution:read",
                )
    return changed


# ── Views ─────────────────────────────────────────────────────────────────────────────────────────
def _views(org_id: Any, cands: list[MatchCandidate]) -> list[MatchCandidateView]:
    from clients import api as clients
    from clients.models import Client, ClientParty

    party_ids = {c.left_id for c in cands} | {c.right_id for c in cands}
    recs = {r.id: r for r in clients.party_records(org_id, party_ids=list(party_ids), active_only=False)}
    by_party: dict[str, set[str]] = {}
    for pid, cid in ClientParty.objects.filter(org_id=org_id, party_id__in=party_ids).values_list(
        "party_id", "client_id"
    ):
        by_party.setdefault(str(pid), set()).add(str(cid))
    for pid, cid in Client.objects.filter(org_id=org_id, party_id__in=party_ids).values_list("party_id", "id"):
        by_party.setdefault(str(pid), set()).add(str(cid))
    names = user_names({c.decided_by_id for c in cands})
    out = []
    for c in cands:
        left = recs.get(str(c.left_id)) or PartyRecord(id=str(c.left_id), kind="other", name="Removed record")
        right = recs.get(str(c.right_id)) or PartyRecord(id=str(c.right_id), kind="other", name="Removed record")
        score = MatchScore(
            probability=c.probability,
            band=c.band,  # type: ignore[arg-type]
            fs_weight=c.fs_weight,
            fs_probability=c.fs_probability,
            features=dict(c.features),
            reasons=[MatchReason(**r) for r in c.reasons],
            model_version=c.model_version,
        )
        out.append(
            MatchCandidateView(
                id=str(c.id),
                status=c.status,  # type: ignore[arg-type]
                left=left,
                right=right,
                score=score,
                client_ids=sorted(by_party.get(str(c.left_id), set()) | by_party.get(str(c.right_id), set())),
                created_at=c.created_at,
                decided_by=names.get(str(c.decided_by_id))
                if c.decided_by_id
                else ("System" if c.status == "auto_merged" else None),
                decided_at=c.decided_at,
                note=c.note or None,
            )
        )
    return out


def list_candidates(
    org_id: Any,
    *,
    status: str | None = "pending",
    band: str | None = None,
    client_id: Any = None,
    offset: int = 0,
    limit: int = 25,
) -> Page[MatchCandidateView]:
    qs = MatchCandidate.objects.filter(org_id=org_id)
    if status:
        qs = qs.filter(status=status)
    if band:
        qs = qs.filter(band=band)
    if client_id:
        from clients import api as clients

        pids = clients.client_party_ids(as_uuid(org_id), as_uuid(client_id))
        qs = qs.filter(Q(left_id__in=pids) | Q(right_id__in=pids))
    qs = qs.order_by("-probability", "id")
    total = qs.count()
    return Page(items=_views(org_id, list(qs[offset : offset + limit])), total=total)


def _candidate(org_id: Any, candidate_id: Any) -> MatchCandidate:
    try:
        return MatchCandidate.objects.get(org_id=org_id, id=as_uuid(candidate_id))
    except MatchCandidate.DoesNotExist as exc:
        raise NotFound("candidate") from exc


def get_candidate(org_id: Any, candidate_id: Any) -> MatchCandidateView:
    return _views(org_id, [_candidate(org_id, candidate_id)])[0]


def decide(org_id: Any, candidate_id: Any, decision: str, actor: Actor, note: str = "") -> MergeOutcome:
    if decision not in ("merge", "not_match", "defer"):
        raise ValueError("decision must be merge, not_match or defer")
    with transaction.atomic():
        cand = MatchCandidate.objects.select_for_update().filter(org_id=org_id, id=as_uuid(candidate_id)).first()
        if cand is None:
            raise NotFound("candidate")
        if cand.status not in ("pending", "deferred"):
            raise DomainConflict("already_decided", "This pair has already been decided.")
        cand.note = (note or "").strip()[:2000]
        if decision == "merge":
            from clients.models import Party

            if Party.objects.filter(id__in=[cand.left_id, cand.right_id]).exclude(merged_into__isnull=True).exists():
                raise DomainConflict("conflict", "One of these records has already been merged elsewhere.")
            return _merge(org_id, cand, actor, "merged")
        cand.status = "not_match" if decision == "not_match" else "deferred"
        cand.decided_by_id = actor.user_id
        cand.decided_at = timezone.now()
        cand.save(update_fields=["status", "note", "decided_by", "decided_at", "updated_at"])
        audit(
            actor,
            f"resolution.{'rejected' if decision == 'not_match' else 'deferred'}",
            resource_type="match_candidate",
            resource_id=cand.id,
            metadata={"probability": cand.probability},
        )
        return MergeOutcome(candidate_id=str(cand.id), survivor_id=str(cand.left_id), merged_ids=[], status=cand.status)  # type: ignore[arg-type]


def propose_merge(org_id: Any, left_id: Any, right_id: Any, actor: Actor) -> MatchCandidateView:
    from clients import api as clients

    left_id, right_id = str(as_uuid(left_id)), str(as_uuid(right_id))
    if left_id == right_id:
        raise ValueError("Choose two different records.")
    recs = {r.id: r for r in clients.party_records(as_uuid(org_id), party_ids=[as_uuid(left_id), as_uuid(right_id)])}
    if left_id not in recs or right_id not in recs:
        raise NotFound("party")
    score = score_pair(recs[left_id], recs[right_id])
    with transaction.atomic():
        cand, _ = _store(org_id, left_id, right_id, score, origin="manual", force_pending=True)
        audit(
            actor,
            "resolution.proposed",
            resource_type="match_candidate",
            resource_id=cand.id,
            metadata={"probability": score.probability},
        )
    publish(
        org_id, "resolution.candidate", {"candidateId": str(cand.id), "band": cand.band}, permission="resolution:read"
    )
    return _views(org_id, [cand])[0]


def split(org_id: Any, party_id: Any, record_ids: list[Any], actor: Actor, note: str) -> MergeOutcome:
    from clients import api as clients

    if not record_ids:
        raise ValueError("Choose at least one record to split out.")
    with transaction.atomic():
        restored = clients.split_party(as_uuid(org_id), as_uuid(party_id), [as_uuid(r) for r in record_ids], actor)
        restored_s = [str(r) for r in restored]
        records = list(
            MergeRecord.objects.filter(
                org_id=org_id, survivor_id=party_id, merged_id__in=restored_s, undone_at__isnull=True
            )
        )
        now = timezone.now()
        cand_id = None
        for mr in records:
            mr.undone_at = now
            mr.save(update_fields=["undone_at"])
            if mr.candidate_id:
                cand_id = str(mr.candidate_id)
                MatchCandidate.objects.filter(id=mr.candidate_id).update(
                    status="not_match",
                    note=(note or "Split after review")[:2000],
                    decided_by_id=actor.user_id,
                    decided_at=now,
                )
        audit(
            actor, "resolution.split", resource_type="party", resource_id=party_id, metadata={"restoredIds": restored_s}
        )
    publish(org_id, "resolution.merged", {"survivorId": str(party_id), "mergedIds": []}, permission="graph:read")
    return MergeOutcome(candidate_id=cand_id, survivor_id=str(party_id), merged_ids=restored_s, status="not_match")


def queue_stats(org_id: Any) -> dict[str, int | float]:
    since = timezone.now() - timedelta(days=30)
    qs = MatchCandidate.objects.filter(org_id=org_id)
    scored = qs.filter(created_at__gte=timezone.now() - timedelta(days=90)).count()
    review = qs.filter(created_at__gte=timezone.now() - timedelta(days=90), band="review").count()
    rate = round(review / scored, 4) if scored else thresholds().expected_review_rate
    return {
        "pending": qs.filter(status__in=["pending", "deferred"]).count(),
        "autoMergedLast30d": qs.filter(status="auto_merged", decided_at__gte=since).count(),
        "decidedLast30d": qs.filter(
            status__in=["merged", "not_match"], decided_by__isnull=False, decided_at__gte=since
        ).count(),
        "reviewRate": rate,
    }


def labelled_pairs(org_id: Any) -> list[dict[str, Any]]:
    """Officers' decisions as labelled training pairs (features + label), for the next retraining round."""
    out = []
    for c in MatchCandidate.objects.filter(org_id=org_id, status__in=["merged", "not_match"], decided_by__isnull=False):
        out.append({**c.features, "label": int(c.status == "merged")})
    return out
