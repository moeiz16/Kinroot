"""`GET /api/v1/events/stream`: Server-Sent Events tailed from jobs.Event rows (contract §SSE).

Events are org-scoped and filtered per recipient: `permission` must be held, and `user_ids` (restricted case
events, job updates) must name the recipient. A `heartbeat` comment goes out every 15 s. Clients resume with
`Last-Event-ID` (or `?lastEventId=`). Exempt from rate limits.
"""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from collections.abc import AsyncIterator

from asgiref.sync import sync_to_async
from django.conf import settings
from django.http import HttpRequest, HttpResponse, StreamingHttpResponse

from accounts.roles import permissions_for
from api.auth import check_session
from api.base import active_membership
from jobs.models import Event
from kinroot.core.camel import camelize
from kinroot.core.errors import AppError, problem_response

BATCH = 100


def scan(org_id: uuid.UUID, user_id: uuid.UUID, perms: frozenset[str], after: int) -> tuple[list[Event], int]:
    """Events after `after` this recipient may see (oldest first), and the cursor past everything scanned."""
    rows = list(Event.objects.filter(org_id=org_id, id__gt=after).order_by("id")[:BATCH])
    uid = str(user_id)
    out = []
    for e in rows:
        if e.permission and e.permission not in perms:
            continue
        if e.user_ids is not None and uid not in e.user_ids:
            continue
        out.append(e)
    return out, (rows[-1].id if rows else after)


def deliverable(org_id: uuid.UUID, user_id: uuid.UUID, perms: frozenset[str], after: int) -> list[Event]:
    return scan(org_id, user_id, perms, after)[0]


def latest_id(org_id: uuid.UUID) -> int:
    row = Event.objects.filter(org_id=org_id).order_by("-id").only("id").first()
    return row.id if row else 0


def format_event(e: Event) -> str:
    return f"id: {e.id}\nevent: {e.name}\ndata: {json.dumps(camelize(e.data), separators=(',', ':'))}\n\n"


def _context(request: HttpRequest) -> tuple[uuid.UUID, uuid.UUID, frozenset[str]]:
    user = request.user
    if not user or not user.is_authenticated:
        raise AppError(401, "not_authenticated", "Unauthorized", "Please sign in.")
    check_session(request)
    membership = active_membership(request)
    if membership is None:
        raise AppError(403, "forbidden", "Forbidden", "You're not a member of a firm yet.")
    request.session.save()
    return membership.org_id, user.id, permissions_for(membership.role)


def _start_id(request: HttpRequest, org_id: uuid.UUID) -> int:
    raw = request.headers.get("Last-Event-ID") or request.GET.get("lastEventId")
    if raw is None:
        return latest_id(org_id)
    try:
        return max(0, int(raw))
    except ValueError:
        return latest_id(org_id)


async def _stream(org_id: uuid.UUID, user_id: uuid.UUID, perms: frozenset[str], after: int) -> AsyncIterator[str]:
    cfg = settings.KINROOT
    poll = float(cfg.get("SSE_POLL_SECONDS", 1.0))
    heartbeat = float(cfg.get("SSE_HEARTBEAT_SECONDS", 15))
    max_seconds = float(cfg.get("SSE_MAX_SECONDS", 300))
    started = last_beat = time.monotonic()
    yield "retry: 3000\n\n"
    fetch = sync_to_async(scan, thread_sensitive=True)
    while True:
        rows, after = await fetch(org_id, user_id, perms, after)
        for e in rows:
            yield format_event(e)
        now = time.monotonic()
        if now - started >= max_seconds:
            return
        if now - last_beat >= heartbeat:
            last_beat = now
            yield ": heartbeat\n\n"
        await asyncio.sleep(poll)


async def events_stream(request: HttpRequest) -> HttpResponse | StreamingHttpResponse:
    if request.method != "GET":
        return problem_response(405, "Method not allowed", code="method_not_allowed")
    try:
        request.user = await request.auser()  # type: ignore[attr-defined]
        org_id, user_id, perms = await sync_to_async(_context, thread_sensitive=True)(request)
        after = await sync_to_async(_start_id, thread_sensitive=True)(request, org_id)
    except AppError as exc:
        return problem_response(exc.status, exc.title, code=exc.code, detail=exc.detail, headers=exc.headers)
    resp = StreamingHttpResponse(_stream(org_id, user_id, perms, after), content_type="text/event-stream")
    resp["Cache-Control"] = "no-cache, no-transform"
    resp["X-Accel-Buffering"] = "no"
    return resp
