"""Builds the demo firms (contract Part 5): rows first, then the domain pipeline, then the human decisions.

Idempotent: a firm that already exists is left alone. Dates are relative to the day the seed runs. Each
domain step is guarded so that a module still being built never stops the platform data from loading.
"""

from __future__ import annotations

import hashlib
import json
import time
import uuid
from collections.abc import Callable
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

import structlog
from django.conf import settings
from django.core.files.base import ContentFile
from django.db import transaction
from django.utils import timezone

from accounts.models import Membership, Organisation, TrainingRecord, User
from accounts.services import default_settings
from audit import api as audit
from cases.models import Case, CaseAccess, Concern, SmrDraft
from clients import seed_data as D  # noqa: N812
from clients import services
from clients.models import Client, Consent, Document, EddMeasure, Party, Relationship, SignOff, VerificationCheck
from kinroot.contracts import Actor
from kinroot.core.dates import add_business_days, add_years

log = structlog.get_logger("kinroot.seed")

SAMPLE_PDF = (
    b"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj "
    b"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 120]>>endobj\n% Sample identity document (fictional)\n%%EOF\n"
)


class Seeder:
    def __init__(self, *, out: Callable[[str], None] = print) -> None:
        self.out = out
        self.today = timezone.localdate()
        self.now = timezone.now()
        self.steps: dict[str, str] = {}
        self.history: list[tuple[datetime, Actor, str, dict[str, Any]]] = []

    # ── helpers ───────────────────────────────────────────────────────────────────────────────────
    def day(self, offset: int) -> date:
        return self.today + timedelta(days=offset)

    def at(self, offset: int, hour: int = 10) -> datetime:
        d = self.day(offset)
        return timezone.make_aware(datetime(d.year, d.month, d.day, hour, (abs(offset) * 7) % 60))

    def step(self, name: str, fn: Callable[[], Any]) -> Any:
        started = time.perf_counter()
        try:
            result = fn()
        except NotImplementedError:
            self.steps[name] = "not available yet"
            self.out(f"  - {name}: skipped (not available yet)")
            return None
        except Exception as exc:
            self.steps[name] = f"failed: {type(exc).__name__}: {exc}"
            log.warning("seed_step_failed", step=name, error=str(exc))
            self.out(f"  ! {name}: {type(exc).__name__}: {exc}")
            return None
        self.steps[name] = f"ok ({time.perf_counter() - started:.1f}s)"
        self.out(f"  - {name}: ok ({time.perf_counter() - started:.1f}s)")
        return result

    def users(self, specs: list[tuple[str, str, str, str, str]], org: Organisation) -> dict[str, User]:
        users = {}
        for key, name, email, role, color in specs:
            user = User.objects.filter(email=email).first()
            if user is None:
                user = User.objects.create_user(email, D.PASSWORD, full_name=name, avatar_color=color)
            Membership.objects.get_or_create(org=org, user=user, defaults={"role": role})
            users[key] = user
        return users

    def actor(self, org: Organisation, user: User | None) -> Actor:
        if user is None:
            return Actor(org_id=org.id, user_id=None)
        return Actor(org_id=org.id, user_id=user.id, name=user.full_name, ip="10.0.0.12")

    def remember(self, when: datetime, actor: Actor, action: str, **kwargs: Any) -> None:
        self.history.append((when, actor, action, kwargs))

    def flush_history(self) -> None:
        for when, actor, action, kwargs in sorted(self.history, key=lambda h: h[0]):
            audit.record(actor, action, at=when, **kwargs)
        self.history.clear()

    # ── structure ─────────────────────────────────────────────────────────────────────────────────
    def parties(self, org: Organisation, specs: dict[str, tuple[str, str, dict[str, Any]]]) -> dict[str, Party]:
        rows: dict[str, Party] = {}
        for key, (kind, name, extra) in specs.items():
            fields = dict(extra)
            if fields.get("birth_date"):
                fields["birth_date"] = date.fromisoformat(fields["birth_date"])
            given, family = services.split_person_name(name) if kind == "person" else ("", "")
            rows[key] = Party(
                id=uuid.uuid5(uuid.NAMESPACE_URL, f"kinroot:{org.id}:{key}"),
                org=org,
                kind=kind,
                name=name,
                normalized_name=services.normalize_name(name),
                given_names=given,
                family_name=family,
                source=fields.pop("source", "seed"),
                source_ref=f"sample:{key}",
                **fields,
            )
        Party.objects.bulk_create(rows.values())
        return rows

    def relationships(
        self, org: Organisation, parties: dict[str, Party], ownership: list[Any], control: list[Any]
    ) -> int:
        rels = []
        for src, dst, pct, interest, since, until in ownership:
            rels.append(
                Relationship(
                    org=org,
                    from_party=parties[src],
                    to_party=parties[dst],
                    kind="ownership",
                    pct=float(pct),
                    interest=interest,
                    valid_from=self.day(since),
                    valid_to=self.day(until) if until is not None else None,
                    source="seed",
                    source_ref="sample",
                )
            )
        for src, dst, role, since, until, nominee in control:
            rels.append(
                Relationship(
                    org=org,
                    from_party=parties[src],
                    to_party=parties[dst],
                    kind="control",
                    role=role,
                    nominee=nominee,
                    valid_from=self.day(since),
                    valid_to=self.day(until) if until is not None else None,
                    source="seed",
                    source_ref="sample",
                )
            )
        Relationship.objects.bulk_create(rels)
        return len(rels)

    def dormant_cluster(self, org: Organisation, parties: dict[str, Party]) -> None:
        pell = parties["gregory_pell"]
        rows, rels = [], []
        for i, word in enumerate(D.DORMANT_WORDS):
            name = f"{word} Trading Ltd"
            p = Party(
                id=uuid.uuid5(uuid.NAMESPACE_URL, f"kinroot:{org.id}:dormant:{i}"),
                org=org,
                kind="company",
                name=name,
                normalized_name=services.normalize_name(name),
                jurisdiction="SC",
                dormant=True,
                address=dict(D.MAHE),
                source="seed",
                source_ref=f"sample:dormant:{i}",
            )
            rows.append(p)
            rels.append(
                Relationship(
                    org=org,
                    from_party=pell,
                    to_party=p,
                    kind="control",
                    role="director",
                    nominee=True,
                    valid_from=self.day(-3000 + i * 40),
                    source="seed",
                    source_ref="sample",
                )
            )
        Party.objects.bulk_create(rows)
        Relationship.objects.bulk_create(rels)

    # ── clients and CDD evidence ──────────────────────────────────────────────────────────────────
    def clients(
        self, org: Organisation, parties: dict[str, Party], specs: list[dict[str, Any]], users: dict[str, User]
    ) -> dict[str, Client]:
        out: dict[str, Client] = {}
        for spec in specs:
            party = parties[spec["party"]]
            status = "active"
            if spec.get("ended") is not None:
                status = "exited"
            elif spec.get("onboarded") is None:
                status = "onboarding"
            onboarded = self.day(spec["onboarded"]) if spec.get("onboarded") is not None else None
            review = spec.get("review")
            client = Client(
                org=org,
                kind=spec["kind"],
                name=party.name,
                party=party,
                status=status,
                jurisdiction=party.jurisdiction or org.country,
                services=spec["services"],
                channel=spec["channel"],
                matter_reference=spec.get("matter") or f"{org.slug[:2].upper()}-{1000 + len(out) * 37}",
                assigned_to=users[spec["assigned"]],
                rating=spec.get("rating"),
                rating_source="rules" if spec.get("rating") else None,
                onboarded_on=onboarded,
                next_review_on=self.day(review) if review is not None else None,
                last_reviewed_on=onboarded,
                relationship_ended_on=self.day(spec["ended"]) if spec.get("ended") else None,
                submitted_at=self.at(spec["submitted"])
                if spec.get("submitted") is not None
                else (self.at(spec["onboarded"] - 3) if onboarded else None),
                seed_key=spec["key"],
            )
            client.save()
            out[spec["key"]] = client
            actor = self.actor(org, users[spec["assigned"]])
            start = (spec.get("onboarded") or spec.get("submitted") or -20) - 10
            self.remember(
                self.at(start, 9),
                actor,
                "client.created",
                resource_type="client",
                resource_id=client.id,
                metadata={"kind": client.kind},
            )
            if client.submitted_at:
                self.remember(
                    client.submitted_at, actor, "client.submitted", resource_type="client", resource_id=client.id
                )
        return out

    def evidence(
        self,
        org: Organisation,
        clients: dict[str, Client],
        specs: list[dict[str, Any]],
        users: dict[str, User],
        parties: dict[str, Party],
    ) -> int:
        """Verification + consent for each natural person in every structure (one person in Lim Family missing)."""
        count = 0
        for spec in specs:
            client = clients[spec["key"]]
            people = list(
                Party.objects.filter(
                    id__in=services.structure_party_ids(org.id, client.id), kind="person", merged_into__isnull=True
                )
            )
            assignee = users[spec["assigned"]]
            base = (spec.get("onboarded") or spec.get("submitted") or -15) - 6
            for person in people:
                if spec.get("incomplete") and person.id == parties[spec["incomplete"]].id:
                    continue
                electronic = bool(spec.get("electronic")) or client.kind != "individual"
                given = self.day(base)
                purpose = "electronic_check" if electronic else "identity_verification"
                Consent.objects.create(
                    org=org,
                    client=client,
                    party=person,
                    purpose=purpose,
                    given_on=given,
                    method="Signed engagement letter" if not electronic else "Online consent form",
                    recorded_by=assignee,
                )
                doc_ids: list[str] = []
                if not electronic:
                    doc = Document(
                        org=org,
                        client=client,
                        party=person,
                        doc_type="passport",
                        file_name=f"passport-{person.family_name.lower() or 'scan'}-sample.pdf",
                        content_type="application/pdf",
                        sha256=hashlib.sha256(SAMPLE_PDF).hexdigest(),
                        size=len(SAMPLE_PDF),
                        uploaded_by=assignee,
                    )
                    doc.file.save(f"{uuid.uuid4().hex}.pdf", ContentFile(SAMPLE_PDF), save=False)
                    doc.save()
                    doc_ids.append(str(doc.id))
                    self.remember(
                        self.at(base, 11),
                        self.actor(org, assignee),
                        "document.uploaded",
                        resource_type="document",
                        resource_id=doc.id,
                        metadata={"clientId": str(client.id), "docType": "passport"},
                    )
                ref = f"MOCK-DVS-{hashlib.sha1(f'{client.id}{person.id}'.encode()).hexdigest()[:8].upper()}"  # noqa: S324
                VerificationCheck.objects.create(
                    org=org,
                    client=client,
                    party=person,
                    method="electronic" if electronic else "document",
                    result="verified",
                    reference=ref,
                    document_ids=doc_ids,
                    checked_by=assignee,
                    checked_at=self.at(base, 12),
                    sources=[
                        {"name": "Credit header (demo)", "matched": ["name", "address"]},
                        {"name": "Electoral roll (demo)", "matched": ["name", "birthDate"]},
                    ]
                    if electronic
                    else [
                        {
                            "name": "Document Verification Service (demo)",
                            "matched": ["name", "birthDate", "documentNumber"],
                        }
                    ],
                )
                self.remember(
                    self.at(base, 12),
                    self.actor(org, assignee),
                    "identity.verified",
                    resource_type="party",
                    resource_id=person.id,
                    metadata={"clientId": str(client.id), "result": "verified"},
                )
                self.remember(
                    self.at(base, 10),
                    self.actor(org, assignee),
                    "consent.recorded",
                    resource_type="party",
                    resource_id=person.id,
                    metadata={"clientId": str(client.id), "purpose": purpose},
                )
                count += 1
        return count

    def training(self, org: Organisation, users: dict[str, User]) -> None:
        for key, course, ago in D.TRAINING:
            done = self.day(-ago)
            TrainingRecord.objects.create(
                org=org,
                user=users[key],
                course=course,
                completed_on=done,
                due_on=add_years(done, 1),
                evidence_note="Certificate on file (sample)",
            )
            self.remember(
                self.at(-ago, 15),
                self.actor(org, users["olivia"]),
                "training.recorded",
                resource_type="training",
                resource_id=users[key].id,
            )

    def org(self, spec: dict[str, Any]) -> Organisation:
        return Organisation.objects.create(
            name=spec["name"],
            slug=spec["slug"],
            country=spec["country"],
            sector=spec["sector"],
            abn=spec["abn"],
            address=spec["address"],
            settings=default_settings(spec["country"]),
        )

    # ── domain pipeline (builder B's public interfaces) ───────────────────────────────────────────
    def pipeline(self, org: Organisation, label: str) -> None:
        from graph import api as graph_api
        from monitoring import api as monitoring_api
        from resolution import api as resolution_api
        from risk import api as risk_api
        from screening import api as screening_api

        system = Actor(org_id=org.id, user_id=None)
        self.out(f"{label}: domain pipeline")
        self.step("graph projection", lambda: graph_api.rebuild_org(org.id))
        self.step("beneficial owners", lambda: self.ubo_counts(org))
        self.step("duplicate detection", lambda: resolution_api.find_candidates(org.id))
        services.rebuild_structure(org.id)
        self.step("screening lists", lambda: screening_api.load_lists())
        self.step("screening", lambda: screening_api.screen_org(org.id, system, reason="seed"))
        seed_methods = getattr(risk_api, "seed_methodologies", None)
        if seed_methods is not None:
            self.step("risk methodology", lambda: seed_methods(org.id))
        self.step("risk assessment", lambda: risk_api.assess_org(org.id, system))
        self.step("daily monitoring", lambda: monitoring_api.run_daily(org.id))

    def ubo_counts(self, org: Organisation) -> int:
        """Cache the number of beneficial owners per client for list views."""
        from graph import api as graph_api

        n = 0
        for client in Client.objects.filter(org=org):
            if client.kind == "individual":
                count = 1
            else:
                result = graph_api.beneficial_owners(org.id, client.id)
                count = sum(1 for o in result.owners if o.is_ubo)
            Client.objects.filter(id=client.id).update(ubo_count=count)
            n += 1
        return n

    # ── human decisions after the pipeline ────────────────────────────────────────────────────────
    def decisions(self, org: Organisation, clients: dict[str, Client], users: dict[str, User]) -> None:
        from screening import api as screening_api

        daniel = self.actor(org, users["daniel"])

        def review_hits() -> int:
            n = 0
            page = screening_api.list_hits(org.id, status="pending", list_kind="pep", limit=200)
            for hit in page.items:
                if hit.entry.id == "SAMPLE-PEP-0003" and hit.party_name.endswith("Julian Whitfield"):
                    screening_api.review_hit(
                        org.id,
                        uuid.UUID(hit.id),
                        "true_match",
                        "Same person: name, date of birth and NSW Legislative Council role confirmed.",
                        daniel,
                    )
                    n += 1
                else:
                    screening_api.review_hit(
                        org.id,
                        uuid.UUID(hit.id),
                        "false_positive",
                        "Different person: date of birth and public role do not match.",
                        daniel,
                    )
                    n += 1
            return n

        self.step("screening decisions", review_hits)
        self.step("EDD workflow", lambda: self.edd_states(org, clients, users))

    def edd_states(self, org: Organisation, clients: dict[str, Client], users: dict[str, User]) -> None:
        from risk import api as risk_api

        in_progress = {"tasman-ridge", "ironbark-ventures", "southbank-holdings", "aurelian-shipping"}
        awaiting_compliance = {"lumen-trade", "silverbirch"}
        fallback = {
            "high": [
                {
                    "code": "high_rating",
                    "message": "Rated high risk",
                    "measures": ["source_of_wealth", "source_of_funds", "enhanced_monitoring"],
                }
            ],
        }
        for key, client in clients.items():
            client.refresh_from_db()
            if client.status == "exited":
                continue
            try:
                triggers: list[Any] = list(risk_api.edd_requirements(org.id, client.id))
            except Exception:
                triggers = fallback.get(client.rating or "", [])
            if key == "whitfield-julian" and not triggers:
                triggers = [
                    {
                        "code": "pep",
                        "message": "Politically exposed person",
                        "measures": ["source_of_wealth", "source_of_funds", "senior_approval"],
                    }
                ]
            if not triggers:
                services.sync_edd(client, [])
                continue
            edd = services.sync_edd(client, triggers)
            assignee = client.assigned_to
            if key in in_progress:
                first = edd.measures.exclude(key="senior_approval").order_by("key").first()
                if first is not None:
                    self._done(first, assignee, -3)
                continue
            for m in edd.measures.exclude(key="senior_approval"):
                self._done(m, assignee, -20 if key != "whitfield-julian" else -6)
            services.refresh_edd_status(edd)
            edd.refresh_from_db()
            if key in awaiting_compliance:
                continue
            SignOff.objects.create(
                org=org,
                edd=edd,
                stage="compliance",
                decision="approve",
                by=users["daniel"],
                at=self.at(-4 if key == "whitfield-julian" else -18, 14),
                note="Source of wealth evidence reviewed and accepted.",
            )
            if services.needs_senior(edd):
                if key == "whitfield-julian":
                    edd.status = "awaiting_senior"
                    edd.save(update_fields=["status", "updated_at"])
                    continue
                approver = users["margaret"] if client.assigned_to_id != users["margaret"].id else users["daniel"]
                SignOff.objects.create(
                    org=org,
                    edd=edd,
                    stage="senior",
                    decision="approve",
                    by=approver,
                    at=self.at(-17, 16),
                    note="Approved to act. Enhanced monitoring in place.",
                )
                edd.measures.filter(key="senior_approval").update(
                    status="done", completed_by=approver, completed_at=self.at(-17, 16)
                )
            edd.status = "approved"
            edd.save(update_fields=["status", "updated_at"])

    def _done(self, measure: EddMeasure, user: Any, offset: int) -> None:
        notes = {
            "source_of_wealth": "Sample evidence: audited accounts and property title searches reviewed.",
            "source_of_funds": "Sample evidence: bank statements for the settlement account.",
            "ubo_verification": "Beneficial owners verified against registry extracts.",
            "purpose_of_relationship": "Purpose recorded in the engagement letter.",
            "adverse_media_check": "No relevant adverse media found.",
            "enhanced_monitoring": "Six-monthly monitoring scheduled.",
        }
        measure.status = "done"
        measure.note = notes.get(measure.key, "Completed (sample).")
        measure.completed_by = user
        measure.completed_at = self.at(offset, 13)
        measure.save()

    def case(self, org: Organisation, clients: dict[str, Client], users: dict[str, User]) -> None:
        client = clients["aurelian-shipping"]
        daniel, margaret = users["daniel"], users["margaret"]
        opened = self.at(-1, 9)
        with transaction.atomic():
            case = Case.objects.create(
                org=org,
                client=client,
                title=D.AURELIAN_CASE["title"],
                grounds=D.AURELIAN_CASE["grounds"],
                opened_by=daniel,
                opened_at=opened,
                deadline_on=add_business_days(opened.date(), 3),
            )
            CaseAccess.objects.create(case=case, user=daniel, level="full", granted_by=daniel)
            CaseAccess.objects.create(case=case, user=margaret, level="summary", granted_by=daniel)
            parties = Party.objects.filter(
                org=org, source_ref__in=["sample:aurelian_shipping", "sample:aurelian_fze", "sample:karim_haddad"]
            )
            roles = {
                "sample:aurelian_shipping": "Client",
                "sample:aurelian_fze": "Sole shareholder",
                "sample:karim_haddad": "Director of the shareholder",
            }
            SmrDraft.objects.create(
                case=case,
                version=1,
                regime="AUSTRAC_SMR",
                updated_by=daniel,
                payload={
                    "suspicion_grounds": D.AURELIAN_CASE["grounds"],
                    "subjects": [{"party_id": str(p.id), "name": p.name, "role": roles[p.source_ref]} for p in parties],
                    "transactions": [
                        {
                            "date": self.day(t["days"]).isoformat(),
                            "amount": t["amount"],
                            "currency": t["currency"],
                            "description": t["description"],
                        }
                        for t in D.AURELIAN_CASE["transactions"]
                    ],
                    "narrative": D.AURELIAN_CASE["narrative"],
                    "attachments": [],
                },
            )
            services.place_hold(client, "restricted", by=daniel, source_ref=str(case.id))
            actor = self.actor(org, daniel)
            audit.record(actor, "case.opened", resource_type="case", resource_id=case.id, restricted=True)
            audit.record(
                actor,
                "case.access_changed",
                resource_type="case",
                resource_id=case.id,
                metadata={"entries": 2},
                restricted=True,
            )
            audit.record(
                actor, "smr.saved", resource_type="case", resource_id=case.id, metadata={"version": 1}, restricted=True
            )
            concern = Concern.objects.create(
                org=org,
                client=clients["lumen-trade"],
                raised_by=users["tom"],
                summary="Director seems to be a stand-in",
                details="Gregory Pell signs for Lumen Trade but defers every question to an overseas contact, and "
                "the registered office is shared with two other new clients.",
            )
            audit.record(
                self.actor(org, users["tom"]),
                "concern.raised",
                resource_type="concern",
                resource_id=concern.id,
                restricted=True,
            )

    # ── firms ─────────────────────────────────────────────────────────────────────────────────────
    def harbourline(self) -> Organisation | None:
        if Organisation.objects.filter(slug=D.HARBOURLINE["slug"]).exists():
            self.out("Harbourline Legal already seeded; leaving it as is.")
            return None
        self.out("Harbourline Legal: firm, members and sample clients")
        with transaction.atomic(), services.structure_sync_suspended():
            org = self.org(D.HARBOURLINE)
            users = self.users(D.HARBOURLINE_MEMBERS, org)
            parties = self.parties(org, D.PARTIES)
            self.relationships(org, parties, D.OWNERSHIP, D.CONTROL)
            self.dormant_cluster(org, parties)
            clients = self.clients(org, parties, D.CLIENTS, users)
            services.rebuild_structure(org.id)
            self.evidence(org, clients, D.CLIENTS, users, parties)
            self.training(org, users)
            self.remember(
                self.at(-1200, 9),
                self.actor(org, users["olivia"]),
                "settings.updated",
                resource_type="org",
                resource_id=org.id,
                metadata={"sections": ["retention", "reviews"]},
            )
            self.flush_history()
        self.pipeline(org, "Harbourline Legal")
        self.decisions(org, clients, users)
        self.step("case and concern", lambda: self.case(org, clients, users))
        return org

    def northgate(self) -> Organisation | None:
        if Organisation.objects.filter(slug=D.NORTHGATE["slug"]).exists():
            self.out("Northgate Accountants already seeded; leaving it as is.")
            return None
        self.out("Northgate Accountants: firm, member and sample clients")
        with transaction.atomic(), services.structure_sync_suspended():
            org = self.org(D.NORTHGATE)
            users = self.users(D.NORTHGATE_MEMBERS, org)
            parties = self.parties(org, D.NORTHGATE_PARTIES)
            self.relationships(org, parties, D.NORTHGATE_OWNERSHIP, D.NORTHGATE_CONTROL)
            clients = self.clients(org, parties, D.NORTHGATE_CLIENTS, users)
            uk = self._uk_company(org, users["priya"])
            clients[uk.seed_key or "uk-company"] = uk
            services.rebuild_structure(org.id)
            specs = [
                *D.NORTHGATE_CLIENTS,
                {"key": uk.seed_key, "assigned": "priya", "onboarded": -150, "kind": "company"},
            ]
            self.evidence(org, clients, specs, users, parties)
            self.flush_history()
        self.pipeline(org, "Northgate Accountants")
        return org

    def _uk_company(self, org: Organisation, priya: User) -> Client:
        from clients import registry

        source_ref, reference = "uk_ch", "14827360"
        sample = Path(settings.DATA_DIR) / "companies_house" / "psc_structures.jsonl"
        name = "Thamesgate Property Holdings Ltd"
        if sample.is_file():
            with sample.open(encoding="utf-8") as fh:
                first = fh.readline()
            if first.strip():
                reference = json.loads(first)["companyNumber"]
                name = f"Companies House sample company {reference}"
        party = Party.objects.create(
            org=org,
            kind="company",
            name=name,
            normalized_name=services.normalize_name(name),
            jurisdiction="GB",
            identifiers={"ukCompanyNumber": reference},
            source="uk_ch",
            source_ref=f"uk_ch:{reference}",
        )
        client = Client.objects.create(
            org=org,
            kind="company",
            name=name,
            party=party,
            status="active",
            jurisdiction="GB",
            services=["audit", "tax_advice"],
            channel="remote",
            matter_reference="NG-4410",
            assigned_to=priya,
            rating="medium",
            rating_source="rules",
            onboarded_on=self.day(-150),
            last_reviewed_on=self.day(-150),
            next_review_on=self.day(580),
            submitted_at=self.at(-153),
            seed_key="uk-company",
        )
        try:
            registry.import_entry(client, source_ref, reference)
        except LookupError:
            registry.import_entry(client, source_ref, "14827360")
        return client

    def run(self) -> dict[str, Any]:
        started = time.perf_counter()
        previous = settings.KINROOT.get("GRAPH_WRITER")
        settings.KINROOT["GRAPH_WRITER"] = "inline"
        try:
            hl = self.harbourline()
            ng = self.northgate()
        finally:
            settings.KINROOT["GRAPH_WRITER"] = previous
        return {
            "harbourline": bool(hl),
            "northgate": bool(ng),
            "seconds": round(time.perf_counter() - started, 1),
            "steps": self.steps,
        }
