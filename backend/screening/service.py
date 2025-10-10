"""Screening services: list loading, the matcher index, client/book screening, hit review."""

from __future__ import annotations

import json
import logging
import threading
from pathlib import Path
from typing import Any, cast

from django.conf import settings
from django.db import IntegrityError, transaction
from django.db.models import Q
from django.utils import timezone

from graph.common import as_uuid, audit, kinroot_setting, org_settings, publish, system_actor, user_names
from kinroot.contracts import (
    Actor,
    DomainConflict,
    ListEntryView,
    MatchReason,
    NotFound,
    Page,
    ScreeningHitView,
    ScreeningRunResult,
)

from . import attribution
from .matcher import DEFAULT_THRESHOLD, Entry, ListIndex, screen
from .models import ListEntry, ListVersion, ScreeningHit, ScreeningRun

log = logging.getLogger(__name__)
SAMPLE_PATH = Path(__file__).resolve().parent / "data" / "sample_lists.json"
OS_SCHEMAS = {"Person", "Organization", "Company", "LegalEntity"}
_index_lock = threading.Lock()
_index_cache: dict[str, Any] = {"key": None, "index": None}


# ── Loading ───────────────────────────────────────────────────────────────────────────────────────
SAMPLE_TITLES = {"pep": "Sample PEP list", "sanctions": "Sample sanctions list"}


def _ftm_entry(ent: dict[str, Any], list_kind: str) -> dict[str, Any] | None:
    if ent.get("schema") not in OS_SCHEMAS:
        return None
    props = ent.get("properties") or {}
    names = props.get("name") or ([ent["caption"]] if ent.get("caption") else [])
    if not names:
        return None
    topics = set(props.get("topics") or [])
    if list_kind == "pep" and ent.get("schema") != "Person":
        return None
    if list_kind == "pep" and topics and not any(t.startswith("role.") or t == "poi" for t in topics):
        return None
    aliases = [a for a in (props.get("alias", []) + props.get("weakAlias", []) + names[1:]) if a and a != names[0]]
    countries = sorted(
        {
            c.upper()[:2]
            for c in props.get("nationality", []) + props.get("citizenship", []) + props.get("country", [])
            if c
        }
    )
    programs = (props.get("program") or []) + (props.get("position") or [])
    dob = (props.get("birthDate") or [""])[0][:10]
    return {
        "entry_id": ent["id"],
        "list_kind": list_kind,
        "schema": ent.get("schema", "Person"),
        "name": names[0][:300],
        "aliases": aliases[:20],
        "birth_date": dob,
        "countries": countries,
        "programs": programs[:10],
        "identifiers": {k: props[k][0] for k in ("registrationNumber", "imoNumber", "innCode") if props.get(k)},
    }


def _load_version(
    source: str, list_kind: str, version: str, rows: list[dict[str, Any]], *, title: str, licence: str, sample: bool
) -> tuple[ListVersion, bool]:
    existing = ListVersion.objects.filter(source=source, list_kind=list_kind, version=version).first()
    if existing is not None:
        if not existing.is_current:
            ListVersion.objects.filter(source=source, list_kind=list_kind).update(is_current=False)
            existing.is_current = True
            existing.save(update_fields=["is_current"])
        return existing, False
    with transaction.atomic():
        ListVersion.objects.filter(source=source, list_kind=list_kind).update(is_current=False)
        lv = ListVersion.objects.create(
            list_kind=list_kind,
            source=source,
            version=version,
            title=title,
            licence=licence,
            entries=len(rows),
            is_sample=sample,
            is_current=True,
        )
        batch = []
        for r in rows:
            batch.append(ListEntry(version=lv, url=r.pop("url", "") or "", **r))
            if len(batch) >= 2000:
                ListEntry.objects.bulk_create(batch)
                batch = []
        if batch:
            ListEntry.objects.bulk_create(batch)
    return lv, True


def _bundled_rows() -> tuple[str, dict[str, list[dict[str, Any]]]]:
    doc = json.loads(SAMPLE_PATH.read_text())
    rows: dict[str, list[dict[str, Any]]] = {"sanctions": [], "pep": []}
    for ent in doc["entities"]:
        kind = "pep" if "role.pep" in (ent["properties"].get("topics") or []) else "sanctions"
        r = _ftm_entry(ent, kind)
        if r:
            rows[kind].append(r)
    return doc["version"], rows


def load_lists(*, source: str | None = None) -> dict[str, str]:
    """Load the bundled sample lists, plus the OpenSanctions subset when SANCTIONS_SOURCE=opensanctions.
    A version not seen before triggers an org-wide re-screen (list-update monitoring)."""
    source = source or str(kinroot_setting("SANCTIONS_SOURCE", "bundled"))
    loaded: dict[str, str] = {}
    created_any = False
    version, rows = _bundled_rows()
    for kind, items in rows.items():
        _, created = _load_version(
            "bundled-sample",
            kind,
            version,
            items,
            title=SAMPLE_TITLES.get(kind, f"Sample {kind} list"),
            licence="sample",
            sample=True,
        )
        created_any |= created
        loaded[f"bundled-sample:{kind}"] = version
    if source == "opensanctions":
        manifest_path = Path(settings.DATA_DIR) / "opensanctions" / "manifest.json"
        if not manifest_path.exists():
            raise ValueError("OpenSanctions data not found: run `make data` first.")
        manifest = json.loads(manifest_path.read_text())
        for dataset, meta in sorted(manifest.items()):
            kind = meta.get("kind", "sanctions")
            items = []
            path = manifest_path.parent / meta["file"]
            with path.open() as fh:
                for line in fh:
                    r = _ftm_entry(json.loads(line), kind)
                    if r:
                        r["url"] = f"https://www.opensanctions.org/entities/{r['entry_id']}/"
                        items.append(r)
            _, created = _load_version(
                f"opensanctions:{dataset}",
                kind,
                meta["version"],
                items,
                title=meta.get("title", dataset),
                licence=attribution.OPENSANCTIONS_LICENCE,
                sample=False,
            )
            created_any |= created
            loaded[f"opensanctions:{dataset}"] = meta["version"]
    invalidate_index()
    if created_any:
        _schedule_rescreens()
    return loaded


def _schedule_rescreens() -> None:
    from accounts.models import Organisation
    from clients.models import Client

    for org in Organisation.objects.all():
        if not Client.objects.filter(org=org).exists():
            continue
        if not org_settings(org.id).get("screening", {}).get("auto_rescreen_on_list_update", True):
            continue
        try:
            from graph.common import enqueue

            enqueue("screening.rescreen_org", {"reason": "list_update"}, org_id=org.id, dedupe_key=f"rescreen:{org.id}")
        except Exception:
            log.exception("could not enqueue re-screen")


def current_versions() -> list[ListVersion]:
    return list(ListVersion.objects.filter(is_current=True).order_by("list_kind", "source"))


def ensure_lists() -> None:
    if not ListVersion.objects.filter(is_current=True).exists():
        load_lists()


def invalidate_index() -> None:
    with _index_lock:
        _index_cache["key"] = None
        _index_cache["index"] = None


def get_index() -> ListIndex:
    ensure_lists()
    versions = current_versions()
    key = ",".join(f"{v.id}" for v in versions)
    with _index_lock:
        if _index_cache["key"] == key and _index_cache["index"] is not None:
            return _index_cache["index"]
        entries = [
            Entry(
                e.entry_id,
                e.list_kind,
                e.schema,
                e.name,
                list(e.aliases),
                e.birth_date,
                list(e.countries),
                list(e.programs),
                pk=e.id,
            )
            for e in ListEntry.objects.filter(version__in=versions).only(
                "id", "entry_id", "list_kind", "schema", "name", "aliases", "birth_date", "countries", "programs"
            )
        ]
        idx = ListIndex(entries)
        _index_cache["key"], _index_cache["index"] = key, idx
        return idx


def version_map() -> dict[str, str]:
    return {f"{v.source}:{v.list_kind}": v.version for v in current_versions()}


def list_versions() -> list[dict[str, Any]]:
    ensure_lists()
    out = []
    for v in current_versions():
        out.append(
            {
                "list": v.list_kind,
                "source": v.source,
                "title": v.title,
                "version": v.version,
                "entries": v.entries,
                "loadedAt": v.loaded_at.isoformat(),
                "sample": v.is_sample,
                "licence": v.licence,
                "attribution": attribution.BUNDLED if v.is_sample else attribution.OPENSANCTIONS,
            }
        )
    return out


# ── Screening ─────────────────────────────────────────────────────────────────────────────────────
def _threshold(org_id: Any) -> float:
    try:
        return float(org_settings(org_id)["screening"]["fuzzy_threshold"])
    except Exception:
        return DEFAULT_THRESHOLD


def _screen_parties(
    org_id: Any, client: Any, party_ids: list[Any], run: ScreeningRun, threshold: float
) -> list[ScreeningHit]:
    from clients import api as clients

    index = get_index()
    records = clients.party_records(as_uuid(org_id), party_ids=list(party_ids))
    new: list[ScreeningHit] = []
    for rec in records:
        for entry, score, reasons in screen(index, rec, threshold=threshold):
            if ScreeningHit.objects.filter(party_id=rec.id, entry_key=entry.id).exists():
                continue
            try:
                with transaction.atomic():
                    hit = ScreeningHit.objects.create(
                        org_id=org_id,
                        client=client,
                        party_id=rec.id,
                        entry_key=entry.id,
                        entry=ListEntry.objects.filter(id=entry.pk).first() if entry.pk is not None else None,
                        list_kind=entry.list_kind,
                        score=score,
                        reasons=[r.__dict__ for r in reasons],
                        run=run,
                    )
            except IntegrityError:
                continue
            new.append(hit)
    return new


def screen_client(org_id: Any, client_id: Any, actor: Actor, *, reason: str = "manual") -> ScreeningRunResult:
    from clients import api as clients
    from clients.models import Client

    client = Client.objects.filter(org_id=org_id, id=as_uuid(client_id)).first()
    if client is None:
        raise NotFound("client")
    party_ids = clients.client_party_ids(as_uuid(org_id), client.id)
    run = ScreeningRun.objects.create(org_id=org_id, client=client, reason=reason, list_versions=version_map())
    new = _screen_parties(org_id, client, party_ids, run, _threshold(org_id))
    run.screened, run.new_hits = len(party_ids), len(new)
    run.save(update_fields=["screened", "new_hits"])
    _after_new_hits(org_id, new, reason)
    audit(
        actor,
        "screening.run",
        resource_type="client",
        resource_id=client.id,
        metadata={"screened": len(party_ids), "newHits": len(new), "reason": reason},
    )
    return ScreeningRunResult(
        run_id=str(run.id),
        client_id=str(client.id),
        screened_parties=len(party_ids),
        new_hits=len(new),
        list_versions=run.list_versions,
    )


def screen_org(org_id: Any, actor: Actor, *, reason: str = "list_update") -> ScreeningRunResult:
    from clients import api as clients
    from clients.models import Client

    run = ScreeningRun.objects.create(org_id=org_id, client=None, reason=reason, list_versions=version_map())
    threshold = _threshold(org_id)
    seen: set[str] = set()
    new: list[ScreeningHit] = []
    for client in Client.objects.filter(org_id=org_id).exclude(status="exited").order_by("name"):
        pids = [p for p in clients.client_party_ids(as_uuid(org_id), client.id) if str(p) not in seen]
        seen |= {str(p) for p in pids}
        if pids:
            new += _screen_parties(org_id, client, pids, run, threshold)
    run.screened, run.new_hits = len(seen), len(new)
    run.save(update_fields=["screened", "new_hits"])
    _after_new_hits(org_id, new, reason)
    audit(
        actor,
        "screening.rescreen",
        resource_type="organisation",
        resource_id=org_id,
        metadata={"screened": len(seen), "newHits": len(new), "reason": reason},
    )
    return ScreeningRunResult(
        run_id=str(run.id),
        client_id=None,
        screened_parties=len(seen),
        new_hits=len(new),
        list_versions=run.list_versions,
    )


def _after_new_hits(org_id: Any, hits: list[ScreeningHit], reason: str) -> None:
    for h in hits:
        publish(
            org_id,
            "screening.hit",
            {
                "hitId": str(h.id),
                "clientId": str(h.client_id) if h.client_id else None,
                "list": h.list_kind,
                "score": h.score,
            },
            permission="screening:read",
        )
    if reason == "list_update" and hits:
        try:
            from monitoring.service import raise_list_update_alerts

            raise_list_update_alerts(org_id, hits)
        except Exception:
            log.exception("list-update alerts failed")


# ── Hits ──────────────────────────────────────────────────────────────────────────────────────────
def _entry_view(e: ListEntry | None, entry_id: str, list_kind: str) -> ListEntryView:
    if e is None:
        return ListEntryView(
            id=entry_id,
            list_kind=cast(Any, list_kind),
            name="(entry no longer listed)",
            aliases=[],
            birth_date=None,
            countries=[],
            programs=[],
            source="",
        )
    v = e.version
    src = f"{v.source}@{v.version}"
    return ListEntryView(
        id=e.entry_id,
        list_kind=e.list_kind,  # type: ignore[arg-type]
        name=e.name,
        aliases=list(e.aliases),
        birth_date=e.birth_date or None,
        countries=list(e.countries),
        programs=list(e.programs),
        source=src,
        url=e.url or None,
    )


def _hit_views(hits: list[ScreeningHit]) -> list[ScreeningHitView]:
    names = user_names({h.reviewed_by_id for h in hits})
    out = []
    for h in hits:
        out.append(
            ScreeningHitView(
                id=str(h.id),
                client_id=str(h.client_id) if h.client_id else "",
                party_id=str(h.party_id),
                party_name=h.party.name,
                entry=_entry_view(h.entry, h.entry_key, h.list_kind),
                score=h.score,
                reasons=[MatchReason(**r) for r in h.reasons],
                status=h.status,  # type: ignore[arg-type]
                created_at=h.created_at,
                reviewed_by=names.get(str(h.reviewed_by_id)) if h.reviewed_by_id else None,
                reviewed_at=h.reviewed_at,
                review_reason=h.review_reason or None,
            )
        )
    return out


def list_hits(
    org_id: Any,
    *,
    status: str | None = "pending",
    client_id: Any = None,
    list_kind: str | None = None,
    offset: int = 0,
    limit: int = 25,
) -> Page[ScreeningHitView]:
    qs = ScreeningHit.objects.filter(org_id=org_id).select_related("party", "entry", "entry__version")
    if status:
        qs = qs.filter(status=status)
    if list_kind:
        qs = qs.filter(list_kind=list_kind)
    if client_id:
        from clients import api as clients

        pids = clients.client_party_ids(as_uuid(org_id), as_uuid(client_id))
        qs = qs.filter(Q(client_id=client_id) | Q(party_id__in=pids))
    qs = qs.order_by("-score", "-created_at", "id")
    total = qs.count()
    return Page(items=_hit_views(list(qs[offset : offset + limit])), total=total)


def _hit(org_id: Any, hit_id: Any) -> ScreeningHit:
    h = (
        ScreeningHit.objects.filter(org_id=org_id, id=as_uuid(hit_id))
        .select_related("party", "entry", "entry__version")
        .first()
    )
    if h is None:
        raise NotFound("hit")
    return h


def get_hit(org_id: Any, hit_id: Any) -> ScreeningHitView:
    return _hit_views([_hit(org_id, hit_id)])[0]


def _clients_of_party(org_id: Any, party_id: Any) -> list[Any]:
    from clients.models import Client, ClientParty

    ids = set(ClientParty.objects.filter(org_id=org_id, party_id=party_id).values_list("client_id", flat=True))
    ids |= set(Client.objects.filter(org_id=org_id, party_id=party_id).values_list("id", flat=True))
    return sorted(ids, key=str)


def review_hit(org_id: Any, hit_id: Any, decision: str, reason: str, actor: Actor) -> ScreeningHitView:
    if decision not in ("true_match", "false_positive", "escalate"):
        raise ValueError("decision must be true_match, false_positive or escalate")
    reason = (reason or "").strip()
    if len(reason) < 10:
        raise ValueError("Give a reason of at least 10 characters.")
    with transaction.atomic():
        h = ScreeningHit.objects.select_for_update().filter(org_id=org_id, id=as_uuid(hit_id)).first()
        if h is None:
            raise NotFound("hit")
        if h.status in ("true_match", "false_positive"):
            raise DomainConflict("already_decided", "This match has already been reviewed.")
        h.status = "escalated" if decision == "escalate" else decision
        h.reviewed_by_id = actor.user_id
        h.reviewed_at = timezone.now()
        h.review_reason = reason
        h.save(update_fields=["status", "reviewed_by", "reviewed_at", "review_reason", "updated_at"])
        audit(
            actor,
            "screening.hit_reviewed",
            resource_type="screening_hit",
            resource_id=h.id,
            metadata={"decision": decision, "list": h.list_kind, "entryId": h.entry_key},
        )
        affected = _clients_of_party(org_id, h.party_id)
        if decision == "true_match" and h.list_kind == "sanctions":
            from clients import api as clients

            for cid in affected:
                clients.block_client(as_uuid(org_id), cid, "sanctions_match", actor)
            try:
                from monitoring.service import raise_alert

                for cid in affected:
                    raise_alert(
                        org_id,
                        cid,
                        "list_update_hit",
                        "critical",
                        "Confirmed sanctions match",
                        "A party in this client's structure is a confirmed match to a sanctions list. "
                        "Work on the matter is stopped.",
                        [{"type": "hit", "id": str(h.id)}, {"type": "node", "id": str(h.party_id)}],
                        dedupe_key=f"sanctions_confirmed:{h.id}:{cid}",
                    )
            except Exception:
                log.exception("sanctions alert failed")
        if decision == "escalate":
            from cases import api as cases

            cases.raise_concern(
                as_uuid(org_id),
                affected[0] if affected else None,
                "Screening match escalated for compliance review",
                f"A possible {h.list_kind} match was escalated by the reviewer. Reason: {reason}",
                actor,
            )
    publish(
        org_id,
        "screening.reviewed",
        {"hitId": str(h.id), "clientId": str(h.client_id) if h.client_id else None, "status": h.status},
        permission="screening:read",
    )
    if decision in ("true_match", "false_positive"):
        _reassess(org_id, affected, actor)
    return get_hit(org_id, h.id)


def _reassess(org_id: Any, client_ids: list[Any], actor: Actor) -> None:
    try:
        from risk import service as risk

        for cid in client_ids:
            risk.assess_client(org_id, cid, actor)
    except Exception:
        log.exception("risk re-assessment after hit review failed")


def get_entry(entry_id: str) -> ListEntryView:
    e = ListEntry.objects.filter(entry_id=entry_id, version__is_current=True).select_related("version").first()
    if e is None:
        raise NotFound("entry")
    return _entry_view(e, e.entry_id, e.list_kind)


def repoint_party(org_id: Any, from_party_id: Any, to_party_id: Any) -> int:
    """After a merge: move hits to the survivor (a duplicate hit on the same entry is dropped, keeping the
    decided one)."""
    moved = 0
    for h in ScreeningHit.objects.filter(org_id=org_id, party_id=from_party_id):
        clash = ScreeningHit.objects.filter(party_id=to_party_id, entry_key=h.entry_key).first()
        if clash is not None:
            if clash.status == "pending" and h.status != "pending":
                clash.delete()
            else:
                h.delete()
                continue
        h.party_id = to_party_id
        h.save(update_fields=["party", "updated_at"])
        moved += 1
    return moved


def system(org_id: Any) -> Actor:
    return system_actor(org_id)
