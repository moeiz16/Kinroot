"""Django -> graph projection (ADR 0002): outbox signals, the single-writer drain, and full rebuilds.

- Signals on clients.Party / clients.Relationship write `GraphOutbox` rows in the caller's transaction.
- GRAPH_WRITER=worker: the worker drains the outbox (`apply_pending`, job "graph.sync" and a 1 s tick); the API
  only reads, through a read-only handle reopened when the sync version moves.
- GRAPH_WRITER=inline: the outbox is applied right after commit, and reads first drain anything this
  connection has written but not applied yet (read-your-writes inside test transactions and the seed).
"""

from __future__ import annotations

import logging
import uuid
from collections import OrderedDict
from typing import Any

from django.db import transaction
from django.db.models import Max, Sum
from django.utils import timezone

from resolution.normalize import address_key, address_text, normalize_name, postcode_of

from . import store as graph_store
from .common import kinroot_setting
from .models import GraphOutbox, GraphSyncState
from .repo import GraphRepo, iso

log = logging.getLogger(__name__)


def inline() -> bool:
    return kinroot_setting("GRAPH_WRITER", "worker") == "inline"


def max_depth() -> int:
    return int(kinroot_setting("GRAPH_MAX_DEPTH", 10))


# ── Row mapping ────────────────────────────────────────────────────────────────────────────────────
def party_row(p: Any) -> dict[str, Any]:
    import json

    return {
        "id": str(p.id),
        "orgId": str(p.org_id),
        "kind": p.kind,
        "name": p.name,
        "normName": normalize_name(p.name, p.kind),
        "jurisdiction": p.jurisdiction or None,
        "identifiers": json.dumps(p.identifiers or {}, sort_keys=True),
        "birthDate": iso(p.birth_date),
        "nationality": p.nationality or None,
        "isNominee": bool(p.is_nominee),
        "dormant": bool(p.dormant),
        "source": p.source or None,
        "sourceRef": p.source_ref or None,
    }


def address_link(p: Any) -> dict[str, Any]:
    key = address_key(str(p.org_id), p.address)
    if not key:
        return {"partyId": str(p.id), "address": None}
    country = (p.address or {}).get("country") if isinstance(p.address, dict) else None
    return {
        "partyId": str(p.id),
        "address": {
            "id": key,
            "label": address_text(p.address),
            "postcode": postcode_of(p.address) or None,
            "country": (country or "")[:2].upper() or None,
        },
    }


def relationship_row(r: Any) -> dict[str, Any]:
    return {
        "id": str(r.id),
        "orgId": str(r.org_id),
        "fromId": str(r.from_party_id),
        "toId": str(r.to_party_id),
        "kind": r.kind,
        "pct": float(r.pct) if r.pct is not None and r.kind == "ownership" else None,
        "interest": r.interest or None,
        "role": r.role or None,
        "nominee": bool(r.nominee),
        "validFrom": iso(r.valid_from),
        "validTo": iso(r.valid_to),
        "source": r.source or None,
        "sourceRef": r.source_ref or None,
    }


# ── Signals ────────────────────────────────────────────────────────────────────────────────────────
def _enqueue(org_id: Any, entity: str, entity_id: Any, op: str, payload: dict[str, Any] | None = None) -> None:
    GraphOutbox.objects.create(org_id=org_id, entity=entity, entity_id=entity_id, op=op, payload=payload or {})
    if inline():
        from django.db import connection

        # one drain per transaction (an empty drain is cheap, but avoid N callbacks for bulk saves)
        pending = getattr(connection, "run_on_commit", [])
        if not any(getattr(cb, "__name__", "") == "_graph_drain" for _sids, cb, *_ in pending):
            transaction.on_commit(_graph_drain)
    else:
        _notify_worker(org_id)


def _graph_drain() -> None:
    apply_pending()


def _notify_worker(org_id: Any) -> None:
    try:
        from jobs import api as jobs

        jobs.enqueue("graph.sync", {"orgId": str(org_id)}, org_id=org_id, dedupe_key="graph.sync", priority=10)
    except Exception:  # pragma: no cover - the worker tick drains the outbox anyway
        log.debug("graph.sync enqueue skipped", exc_info=True)


def on_party_saved(sender: Any, instance: Any, **kwargs: Any) -> None:
    if kwargs.get("raw"):
        return
    _enqueue(instance.org_id, "party", instance.id, "upsert")


def on_party_deleted(sender: Any, instance: Any, **kwargs: Any) -> None:
    _enqueue(instance.org_id, "party", instance.id, "delete")


def on_relationship_saved(sender: Any, instance: Any, **kwargs: Any) -> None:
    if kwargs.get("raw"):
        return
    _enqueue(
        instance.org_id,
        "relationship",
        instance.id,
        "upsert",
        {"fromId": str(instance.from_party_id), "toId": str(instance.to_party_id)},
    )


def on_relationship_deleted(sender: Any, instance: Any, **kwargs: Any) -> None:
    _enqueue(
        instance.org_id,
        "relationship",
        instance.id,
        "delete",
        {"fromId": str(instance.from_party_id), "toId": str(instance.to_party_id)},
    )


def connect() -> None:
    from django.db.models.signals import post_delete, post_save

    from clients.models import Party, Relationship

    post_save.connect(on_party_saved, sender=Party, dispatch_uid="graph.party.saved")
    post_delete.connect(on_party_deleted, sender=Party, dispatch_uid="graph.party.deleted")
    post_save.connect(on_relationship_saved, sender=Relationship, dispatch_uid="graph.rel.saved")
    post_delete.connect(on_relationship_deleted, sender=Relationship, dispatch_uid="graph.rel.deleted")


# ── Drain ──────────────────────────────────────────────────────────────────────────────────────────
def version_token() -> tuple[int, int]:
    agg = GraphSyncState.objects.aggregate(v=Sum("graph_version"), n=Max("graph_version"))
    return int(agg["v"] or 0), int(agg["n"] or 0)


def _bump(org_id: Any, seq: int | None) -> int:
    state, _ = GraphSyncState.objects.get_or_create(org_id=org_id)
    state.graph_version = max(state.graph_version + 1, seq or 0)
    state.last_applied_at = timezone.now()
    state.save(update_fields=["graph_version", "last_applied_at", "updated_at"])
    return state.graph_version


def flush_for_read() -> None:
    """Inline mode only: apply outbox rows written in this connection before reading (read-your-writes)."""
    if inline() and GraphOutbox.objects.filter(applied_at__isnull=True).exists():
        apply_pending()


def apply_pending(limit: int = 500) -> int:
    from clients.models import Party, Relationship

    rows = list(GraphOutbox.objects.filter(applied_at__isnull=True).order_by("seq")[:limit])
    if not rows:
        return 0
    store = graph_store.writer()
    by_org: dict[Any, list[GraphOutbox]] = {}
    for row in rows:
        by_org.setdefault(row.org_id, []).append(row)
    for org_id, org_rows in by_org.items():
        repo = GraphRepo(store, str(org_id), max_depth=max_depth())
        latest: OrderedDict[tuple[str, str], GraphOutbox] = OrderedDict()
        for row in org_rows:  # collapse repeats: the current DB state is what gets projected
            key = (row.entity, str(row.entity_id))
            latest.pop(key, None)
            latest[key] = row
        party_ids = [k[1] for k in latest if k[0] == "party"]
        rel_ids = [k[1] for k in latest if k[0] == "relationship"]
        rels = {str(r.id): r for r in Relationship.objects.filter(org_id=org_id, id__in=rel_ids)}
        endpoint_ids = {str(r.from_party_id) for r in rels.values()} | {str(r.to_party_id) for r in rels.values()}
        parties = {str(p.id): p for p in Party.objects.filter(org_id=org_id, id__in=set(party_ids) | endpoint_ids)}

        upserts, removed = [], []
        for pid, p in parties.items():
            if p.merged_into_id is None:
                upserts.append(p)
            elif pid in party_ids:
                removed.append(pid)
        removed += [pid for pid in party_ids if pid not in parties]
        for pid in removed:
            repo.delete_party(pid)
        repo.upsert_parties([party_row(p) for p in upserts])
        repo.set_addresses([address_link(p) for p in upserts if str(p.id) in party_ids])

        edge_rows, changed_edges = [], []
        for rid in rel_ids:
            r = rels.get(rid)
            changed_edges.append(rid)
            src = parties.get(str(r.from_party_id)) if r is not None else None
            dst = parties.get(str(r.to_party_id)) if r is not None else None
            live = src is not None and dst is not None and not src.merged_into_id and not dst.merged_into_id
            if live and r is not None:
                edge_rows.append(relationship_row(r))
            else:
                repo.delete_edge(rid)
        repo.replace_edges(edge_rows)
        if removed or any(p for p in upserts if str(p.id) in party_ids):
            repo.prune_addresses()

        last_seq = max(r.seq for r in org_rows)
        GraphOutbox.objects.filter(seq__in=[r.seq for r in org_rows]).update(applied_at=timezone.now())
        version = _bump(org_id, last_seq)
        touched = (
            set(party_ids)
            | endpoint_ids
            | {v for row in org_rows for v in (row.payload or {}).values() if isinstance(v, str)}
        )
        client_ids = _clients_touching(org_id, touched)
        _publish(org_id, "graph.synced", {"graphVersion": version, "clientIds": client_ids}, "graph:read")
        if changed_edges and client_ids:
            try:
                from monitoring import api as monitoring

                monitoring.on_structure_changed(
                    uuid.UUID(str(org_id)), [uuid.UUID(c) for c in client_ids], changed_edges
                )
            except Exception:
                log.exception("structure-change monitoring failed")
    return len(rows)


def _clients_touching(org_id: Any, party_ids: set[str]) -> list[str]:
    from clients.models import Client, ClientParty

    ids = [i for i in party_ids if _is_uuid(i)]
    if not ids:
        return []
    out = set(map(str, ClientParty.objects.filter(org_id=org_id, party_id__in=ids).values_list("client_id", flat=True)))
    out |= set(map(str, Client.objects.filter(org_id=org_id, party_id__in=ids).values_list("id", flat=True)))
    return sorted(out)


def _is_uuid(value: str) -> bool:
    try:
        uuid.UUID(str(value))
    except ValueError:
        return False
    return True


def _publish(org_id: Any, event: str, data: dict[str, Any], permission: str | None) -> None:
    try:
        from jobs import api as jobs

        jobs.publish_event(uuid.UUID(str(org_id)), event, data, permission=permission)
    except Exception:  # pragma: no cover - events are best effort
        log.debug("event publish failed", exc_info=True)


def rebuild_org(org_id: Any) -> int:
    """Recreate the org's projection from the system of record (seed, bulk imports, recovery)."""
    from clients.models import Party, Relationship

    store = graph_store.writer()
    repo = GraphRepo(store, str(org_id), max_depth=max_depth())
    repo.clear()
    parties = list(Party.objects.filter(org_id=org_id, merged_into__isnull=True))
    live = {str(p.id) for p in parties}
    n = repo.upsert_parties([party_row(p) for p in parties])
    n += repo.set_addresses([address_link(p) for p in parties])
    rels = [
        r
        for r in Relationship.objects.filter(org_id=org_id)
        if str(r.from_party_id) in live and str(r.to_party_id) in live
    ]
    n += repo.replace_edges([relationship_row(r) for r in rels])
    pending = GraphOutbox.objects.filter(org_id=org_id, applied_at__isnull=True)
    last = pending.aggregate(m=Max("seq"))["m"]
    pending.update(applied_at=timezone.now())
    version = _bump(org_id, last)
    _publish(org_id, "graph.synced", {"graphVersion": version, "clientIds": []}, "graph:read")
    return n


def status(org_id: Any) -> tuple[int, int, Any]:
    state = GraphSyncState.objects.filter(org_id=org_id).first()
    pending = GraphOutbox.objects.filter(org_id=org_id, applied_at__isnull=True).count()
    return (state.graph_version if state else 0, pending, state.last_applied_at if state else None)


def current_version(org_id: Any) -> int:
    state = GraphSyncState.objects.filter(org_id=org_id).only("graph_version").first()
    return state.graph_version if state else 0


def read_repo(org_id: Any) -> GraphRepo:
    flush_for_read()
    store = graph_store.reader(version_token)
    return GraphRepo(store, str(org_id), max_depth=max_depth())
