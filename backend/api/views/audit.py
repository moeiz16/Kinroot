"""Audit trail, verification and export; job status (contract §1.14)."""

from __future__ import annotations

import csv
import io
from datetime import datetime, time
from typing import Any

from django.http import HttpResponse
from django.utils import timezone
from rest_framework.request import Request
from rest_framework.response import Response

from api.base import ApiView, page_params, paged, parse_date, parse_uuid
from api.views.org import job_wire
from audit import api as audit_api
from audit.labels import label_for
from audit.models import AuditLog
from clients.models import Client
from jobs.models import Job
from kinroot.core.errors import not_found

EXPORT_LIMIT = 50_000


def client_names(org_id: Any, rows: list[AuditLog]) -> dict[str, str]:
    ids = {r.resource_id for r in rows if r.resource_type == "client" and r.resource_id}
    return {str(k): v for k, v in Client.objects.filter(org_id=org_id, id__in=ids).values_list("id", "name")}


def entry_wire(r: AuditLog, names: dict[str, str]) -> dict[str, Any]:
    return {
        "id": r.id,
        "action": r.action,
        "label": label_for(r.action, r.metadata, names.get(r.resource_id)),
        "actor_name": r.actor_name,
        "actor_type": r.actor_type,
        "resource_type": r.resource_type or None,
        "resource_id": r.resource_id or None,
        "metadata": r.metadata,
        "ip": r.ip or None,
        "created_at": r.created_at.isoformat(),
        "hash": r.hash,
        "prev_hash": r.prev_hash,
    }


class AuditBase(ApiView):
    permission = "audit:read"

    def rows(self, request: Request) -> Any:
        qs = AuditLog.objects.filter(org=self.org)
        if not self.has("smr:read"):
            qs = qs.filter(restricted=False)
        p = request.query_params
        if action := p.get("action"):
            qs = qs.filter(action__startswith=action) if action.endswith(".") else qs.filter(action=action)
        if actor := p.get("actorId"):
            qs = qs.filter(actor_id=parse_uuid(actor, "Member"))
        if rtype := p.get("resourceType"):
            qs = qs.filter(resource_type=rtype)
        if rid := p.get("resourceId"):
            qs = qs.filter(resource_id=rid)
        tz = timezone.get_current_timezone()
        if start := parse_date(p.get("from"), "from"):
            qs = qs.filter(created_at__gte=datetime.combine(start, time.min, tzinfo=tz))
        if end := parse_date(p.get("to"), "to"):
            qs = qs.filter(created_at__lte=datetime.combine(end, time.max, tzinfo=tz))
        return qs.order_by("-id")


class AuditListView(AuditBase):
    def get(self, request: Request) -> Response:
        qs = self.rows(request)
        page, size = page_params(request)
        total = qs.count()
        rows = list(qs[(page - 1) * size : page * size])
        names = client_names(self.org_id, rows)
        return Response(paged([entry_wire(r, names) for r in rows], total, page, size))


class AuditVerifyView(AuditBase):
    def get(self, request: Request) -> Response:
        return Response(audit_api.verify_chain(self.org_id))


class AuditExportView(AuditBase):
    def get(self, request: Request) -> HttpResponse:
        rows = list(self.rows(request)[:EXPORT_LIMIT])
        names = client_names(self.org_id, rows)
        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow(
            [
                "id",
                "created_at",
                "actor",
                "actor_type",
                "action",
                "label",
                "resource_type",
                "resource_id",
                "ip",
                "prev_hash",
                "hash",
            ]
        )
        for r in rows:
            label = label_for(r.action, r.metadata, names.get(r.resource_id))
            cells = [
                r.id,
                r.created_at.isoformat(),
                r.actor_name,
                r.actor_type,
                r.action,
                label,
                r.resource_type,
                r.resource_id,
                r.ip,
                r.prev_hash,
                r.hash,
            ]
            writer.writerow([_safe_cell(c) for c in cells])
        self.audit("audit.exported", resource_type="org", resource_id=self.org_id, metadata={"rows": len(rows)})
        resp = HttpResponse(buf.getvalue(), content_type="text/csv; charset=utf-8")
        resp["Content-Disposition"] = f'attachment; filename="kinroot-audit-{self.org.slug}.csv"'
        return resp


def _safe_cell(value: Any) -> Any:
    """Neutralise spreadsheet formula injection."""
    if isinstance(value, str) and value[:1] in {"=", "+", "-", "@"}:
        return "'" + value
    return value


class JobView(ApiView):
    def get(self, request: Request, job_id: str) -> Response:
        job = Job.objects.filter(org=self.org, id=parse_uuid(job_id, "Job")).first()
        if job is None:
            raise not_found("Job")
        return Response(job_wire(job))
