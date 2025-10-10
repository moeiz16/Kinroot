"""Dashboard and insights (contract §1.5). Counts the caller may not see are omitted, never zeroed."""

from __future__ import annotations

from collections import Counter
from datetime import date, timedelta
from typing import Any

from django.db.models import Count, Q
from django.utils import timezone
from rest_framework.request import Request
from rest_framework.response import Response

from accounts.models import TrainingRecord
from accounts.services import REGIMES, days_until
from api.base import ApiView
from audit.labels import label_for
from audit.models import AuditLog
from cases.models import SmrDraft
from clients.models import Client, EddCase

TRAY_LIMIT = 6
DUE_SOON_DAYS = 30


def _try(fn: Any, default: Any = None) -> Any:
    try:
        return fn()
    except NotImplementedError:
        return default
    except Exception:  # a domain module still warming up must not break the home screen
        return default


def _officer(label: str) -> str:
    return label.split(" directs")[0] if " directs" in label else "an officer"


def _plural(n: int, word: str) -> str:
    return f"{n} {word}{'' if n == 1 else 's'}"


def _href(client_id: Any, tab: str = "summary") -> str:
    """A route in the web app (docs/API_CONTRACT.md 1.5): the client's dossier on the given folder tab."""
    return f"/clients/{client_id}/{tab}"


TRIGGER_WORDS = {
    "pep": "PEP in structure",
    "high_rating": "high risk rating",
    "high_risk_jurisdiction": "high-risk country in structure",
    "offshore": "offshore layer",
    "nominee": "nominee in structure",
    "complex_structure": "complex structure",
    "unknown_owner": "owner not yet known",
    "circular": "circular ownership",
    "sanctions": "possible sanctions match",
}


SEVERITY_WORDS = {"critical": "act now", "warning": "look this week", "info": "for information"}


def _trigger_word(code: str) -> str:
    return TRIGGER_WORDS.get(code, code.replace("_", " "))


class DashboardView(ApiView):
    permission = "dashboard:read"

    def get(self, request: Request) -> Response:
        today = timezone.localdate()
        org = self.org
        counts: dict[str, int] = {}
        clients = Client.objects.filter(org=org)
        live = clients.exclude(status="exited")
        if self.has("clients:read"):
            counts["clients"] = clients.count()
            counts["high_risk"] = live.filter(rating="high").count()
            active = live.filter(status="active", next_review_on__isnull=False)
            counts["reviews_overdue"] = active.filter(next_review_on__lt=today).count()
            counts["reviews_due_soon"] = active.filter(
                next_review_on__gte=today, next_review_on__lte=today + timedelta(days=DUE_SOON_DAYS)
            ).count()
        if self.has("screening:read"):
            from screening import api as screening_api

            total = _try(lambda: screening_api.list_hits(self.org_id, status="pending", limit=1).total)
            if total is not None:
                counts["screening_backlog"] = total
        if self.has("resolution:read"):
            from resolution import api as resolution_api

            total = _try(lambda: resolution_api.list_candidates(self.org_id, status="pending", limit=1).total)
            if total is not None:
                counts["merge_queue"] = total
        if self.has("monitoring:read"):
            from monitoring import api as monitoring_api

            total = _try(lambda: monitoring_api.list_alerts(self.org_id, status="open", limit=1).total)
            if total is not None:
                counts["open_alerts"] = total
        if self.has("risk:read"):
            edd = EddCase.objects.filter(org=org)
            counts["edd_in_progress"] = edd.filter(status="in_progress").count()
            counts["awaiting_signoff"] = edd.filter(status__in=["awaiting_compliance", "awaiting_senior"]).count()
        if self.has("training:read"):
            counts["training_overdue"] = TrainingRecord.objects.filter(org=org, due_on__lt=today).count()
        if self.has("smr:read"):
            counts["smr_drafts"] = SmrDraft.objects.filter(case__org=org, submitted_at__isnull=True).count()
        rating_mix = None
        if self.has("clients:read"):
            mix = Counter(live.exclude(rating__isnull=True).values_list("rating", flat=True))
            rating_mix = {"low": mix.get("low", 0), "medium": mix.get("medium", 0), "high": mix.get("high", 0)}
        regime = dict(REGIMES.get(org.country, REGIMES["AU"]))
        regime["days_to_commencement"] = days_until(regime.get("commencement"), today)
        body: dict[str, Any] = {
            "file_tray": self.file_tray(today),
            "counts": counts,
            "regime": regime,
            "recent_activity": self.recent_activity(),
        }
        if rating_mix is not None:
            body["rating_mix"] = rating_mix
        return Response(body)

    # ── tray ──────────────────────────────────────────────────────────────────────────────────────
    def file_tray(self, today: date) -> list[dict[str, Any]]:
        tray: list[dict[str, Any]] = []
        user = self.user
        stages = [
            (s, st)
            for s, st in (("compliance", "awaiting_compliance"), ("senior", "awaiting_senior"))
            if self.has(f"signoff:{s}")
        ]
        for stage, status in stages:
            for edd in EddCase.objects.select_related("client").filter(org=self.org, status=status)[:3]:
                if stage == "senior" and edd.client.assigned_to_id == user.id:
                    continue
                codes = [t.get("code", "") for t in edd.triggers or []]
                reason = (
                    _trigger_word("pep")
                    if "pep" in codes
                    else (_trigger_word(codes[0]) if codes else "enhanced checks")
                )
                tray.append(
                    {
                        "kind": "signoff",
                        "id": str(edd.id),
                        "client_id": str(edd.client_id),
                        "title": f"Sign-off needed: {edd.client.name}",
                        "subtitle": f"{'Senior approval' if stage == 'senior' else 'Compliance sign-off'} · {reason}",
                        "due_on": None,
                        "href": _href(edd.client_id, "risk"),
                    }
                )
        if self.has("screening:review"):
            from screening import api as screening_api

            page = _try(lambda: screening_api.list_hits(self.org_id, status="pending", limit=3))
            for hit in getattr(page, "items", []):
                kind = hit.entry.list_kind
                list_word = "PEP" if kind == "pep" else kind.capitalize().replace("_", " ")
                tray.append(
                    {
                        "kind": "hit_review",
                        "id": str(hit.id),
                        "client_id": str(hit.client_id),
                        "title": f"Screening match to review: {hit.party_name}",
                        "subtitle": f"{list_word} list · {round(hit.score * 100)} in 100",
                        "due_on": None,
                        "href": f"/screening/{hit.id}",
                    }
                )
        if self.has("resolution:decide"):
            from resolution import api as resolution_api

            page = _try(lambda: resolution_api.list_candidates(self.org_id, status="pending", band="review", limit=2))
            for cand in getattr(page, "items", []):
                tray.append(
                    {
                        "kind": "merge_review",
                        "id": str(cand.id),
                        "client_id": cand.client_ids[0] if cand.client_ids else None,
                        "title": f"Possible duplicate: {cand.left.name} / {cand.right.name}",
                        "subtitle": f"{round(cand.score.probability * 100)} in 100 likely the same",
                        "due_on": None,
                        "href": f"/fuse/{cand.id}",
                    }
                )
        if self.has("risk:override"):
            from risk import api as risk_api

            page = _try(lambda: risk_api.list_disagreements(self.org_id, status="open", limit=2))
            for d in getattr(page, "items", []):
                tray.append(
                    {
                        "kind": "disagreement",
                        "id": str(d.get("id")),
                        "client_id": d.get("client_id") or d.get("clientId"),
                        "title": f"Second opinion differs: {d.get('client_name') or d.get('clientName')}",
                        "subtitle": "Rules and the pattern check disagree",
                        "due_on": None,
                        "href": _href(d.get("client_id") or d.get("clientId"), "risk"),
                    }
                )
        if self.has("monitoring:read"):
            from monitoring import api as monitoring_api

            page = _try(lambda: monitoring_api.list_alerts(self.org_id, status="open", limit=10))
            mine = (
                None
                if self.has("monitoring:manage")
                else set(Client.objects.filter(org=self.org, assigned_to=user).values_list("id", flat=True))
            )
            for alert in getattr(page, "items", []):
                if mine is not None and str(alert.client_id) not in {str(m) for m in mine}:
                    continue
                if alert.kind == "review_due":
                    continue
                tray.append(
                    {
                        "kind": "alert",
                        "id": str(alert.id),
                        "client_id": str(alert.client_id),
                        "title": alert.title,
                        "subtitle": f"{alert.client_name} · {SEVERITY_WORDS.get(alert.severity, alert.severity)}",
                        "due_on": None,
                        "href": f"/alerts/{alert.id}",
                    }
                )
        reviews = Client.objects.filter(org=self.org, status="active", next_review_on__lte=today + timedelta(days=14))
        if not self.has("monitoring:manage"):
            reviews = reviews.filter(assigned_to=user)
        if self.has("clients:read"):
            for c in reviews.order_by("next_review_on")[:3]:
                overdue = (today - c.next_review_on).days if c.next_review_on else 0
                tray.append(
                    {
                        "kind": "review_due",
                        "id": str(c.id),
                        "client_id": str(c.id),
                        "title": f"Periodic review: {c.name}",
                        "subtitle": f"Overdue by {overdue} days" if overdue > 0 else "Due soon",
                        "due_on": c.next_review_on.isoformat() if c.next_review_on else None,
                        "href": _href(c.id),
                    }
                )
        return tray[:TRAY_LIMIT]

    def recent_activity(self) -> list[dict[str, Any]]:
        qs = AuditLog.objects.filter(org=self.org).exclude(action__startswith="auth.")
        if not self.has("smr:read"):
            qs = qs.filter(restricted=False)
        if not self.has("audit:read"):
            qs = qs.filter(actor_id=self.user.id)
        rows = list(qs.order_by("-id")[:8])
        ids = {r.resource_id for r in rows if r.resource_type == "client"}
        names = {str(k): v for k, v in Client.objects.filter(org=self.org, id__in=ids).values_list("id", "name")}
        return [
            {
                "id": r.id,
                "action": r.action,
                "label": label_for(r.action, r.metadata, names.get(r.resource_id)),
                "actor_name": r.actor_name,
                "created_at": r.created_at.isoformat(),
            }
            for r in rows
        ]


class InsightsView(ApiView):
    permission = "insights:read"

    def get(self, request: Request) -> Response:
        today = timezone.localdate()
        out: list[dict[str, Any]] = []
        from graph import api as graph_api

        clusters = _try(lambda: graph_api.clusters(self.org_id, kinds=["shared_officer"]), []) or []
        if clusters:
            top = max(clusters, key=lambda c: (len(c.client_ids), c.size))
            if len(top.client_ids) >= 2:
                out.append(
                    {
                        "id": "shared-officer",
                        "tone": "risk",
                        "title": f"{len(top.client_ids)} clients share {_officer(top.label)}",
                        "body": top.reason or top.label,
                        "metric": {"value": top.size, "unit": "linked companies", "trend": "flat"},
                        "href": "/board?lens=shared",
                    }
                )
        active = Client.objects.filter(org=self.org, status="active", next_review_on__isnull=False)
        overdue = active.filter(next_review_on__lt=today)
        n_overdue = overdue.count()
        if n_overdue:
            mix = dict(overdue.values_list("rating").annotate(n=Count("id")).values_list("rating", "n"))
            parts = ", ".join(f"{n} {r or 'unrated'}" for r, n in sorted(mix.items(), key=lambda x: str(x[0])))
            out.append(
                {
                    "id": "reviews-overdue",
                    "tone": "risk",
                    "title": f"Reviews overdue: {n_overdue}",
                    "body": f"Periodic reviews past their due date ({parts} risk).",
                    "metric": {"value": n_overdue, "unit": "clients", "trend": "flat"},
                    "href": "/board?lens=review",
                }
            )
        from risk import api as risk_api

        agree = total = 0
        for cid in Client.objects.filter(org=self.org, status__in=["active", "onboarding"]).values_list(
            "id", flat=True
        ):
            a = _try(lambda cid=cid: risk_api.latest_assessment(self.org_id, cid))
            if a is not None and a.challenger is not None:
                total += 1
                agree += a.challenger.agreement == "agree"
        if total:
            pct = round(100 * agree / total)
            out.append(
                {
                    "id": "second-opinion",
                    "tone": "info",
                    "title": f"Rules and the second-opinion check agree on {pct}% of clients",
                    "body": f"{_plural(total - agree, 'client')} flagged for a closer look by the pattern check.",
                    "metric": {"value": pct, "unit": "%", "trend": "flat"},
                    "href": "/settings/risk-method",
                }
            )
        onboarded = Client.objects.filter(org=self.org, onboarded_on__gte=today - timedelta(days=90))
        if onboarded.exists():
            n = onboarded.count()
            out.append(
                {
                    "id": "onboarded",
                    "tone": "progress",
                    "title": f"{n} client{'s' if n != 1 else ''} onboarded in 90 days",
                    "body": "Identity, beneficial owners, screening and risk completed before work started.",
                    "metric": {"value": n, "unit": "clients", "trend": "up"},
                    "href": "/clients",
                }
            )
        awaiting = EddCase.objects.filter(org=self.org, status__in=["awaiting_compliance", "awaiting_senior"]).count()
        if awaiting:
            out.append(
                {
                    "id": "awaiting-signoff",
                    "tone": "progress",
                    "title": f"{awaiting} file{'s' if awaiting != 1 else ''} awaiting sign-off",
                    "body": "Enhanced due diligence is complete and waiting for approval.",
                    "metric": {"value": awaiting, "unit": "files", "trend": "flat"},
                    "href": "/clients?filter=needs",
                }
            )
        high = (
            Client.objects.filter(org=self.org, rating="high")
            .exclude(status="exited")
            .filter(Q(party__jurisdiction__in=["VG", "KY", "SC", "AE"]) | Q(edd_required=True))
            .count()
        )
        if high:
            out.append(
                {
                    "id": "high-risk",
                    "tone": "risk",
                    "title": f"{high} high-risk clients need enhanced checks",
                    "body": "Offshore layers, politically exposed people or complex structures.",
                    "metric": {"value": high, "unit": "clients", "trend": "flat"},
                    "href": "/clients?filter=needs",
                }
            )
        return Response(out)
