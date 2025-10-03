"""A small world builder for domain tests: an organisation, parties, relationships and clients.

Rows are created through the ORM so the real signals run (graph outbox, client structure membership).
"""

from __future__ import annotations

import uuid
from datetime import date
from typing import Any

from accounts.models import Membership, Organisation, User
from clients.models import Client, Party, Relationship
from kinroot.contracts import Actor


class World:
    def __init__(self, name: str = "Test Firm", country: str = "AU") -> None:
        self.org = Organisation.objects.create(name=name, slug=f"t-{uuid.uuid4().hex[:10]}", country=country)
        self.p: dict[str, Party] = {}
        self.r: dict[str, Relationship] = {}
        self.c: dict[str, Client] = {}
        self.users: dict[str, User] = {}

    @property
    def org_id(self) -> uuid.UUID:
        return self.org.id

    def party(self, key: str, kind: str = "company", name: str | None = None, **kw: Any) -> Party:
        p = Party.objects.create(org=self.org, kind=kind, name=name or key.replace("_", " ").title(), **kw)
        self.p[key] = p
        return p

    def person(self, key: str, name: str | None = None, **kw: Any) -> Party:
        return self.party(key, "person", name, **kw)

    def company(self, key: str, name: str | None = None, jurisdiction: str = "AU", **kw: Any) -> Party:
        return self.party(key, "company", name, jurisdiction=jurisdiction, **kw)

    def own(
        self,
        a: str,
        b: str,
        pct: float,
        since: str = "2019-01-01",
        until: str | None = None,
        key: str | None = None,
        **kw: Any,
    ) -> Relationship:
        r = Relationship.objects.create(
            org=self.org,
            from_party=self.p[a],
            to_party=self.p[b],
            kind="ownership",
            pct=pct,
            interest=kw.pop("interest", "shares"),
            valid_from=date.fromisoformat(since),
            valid_to=date.fromisoformat(until) if until else None,
            **kw,
        )
        self.r[key or f"{a}>{b}"] = r
        return r

    def control(
        self,
        a: str,
        b: str,
        role: str,
        since: str = "2019-01-01",
        until: str | None = None,
        key: str | None = None,
        **kw: Any,
    ) -> Relationship:
        r = Relationship.objects.create(
            org=self.org,
            from_party=self.p[a],
            to_party=self.p[b],
            kind="control",
            role=role,
            valid_from=date.fromisoformat(since),
            valid_to=date.fromisoformat(until) if until else None,
            **kw,
        )
        self.r[key or f"{a}~{b}"] = r
        return r

    def client(
        self,
        key: str,
        party_key: str,
        *,
        kind: str | None = None,
        status: str = "active",
        onboarded: date | None = date(2023, 1, 2),
        **kw: Any,
    ) -> Client:
        p = self.p[party_key]
        ck = kind or {"person": "individual"}.get(p.kind, p.kind)
        c = Client.objects.create(
            org=self.org,
            kind=ck,
            name=p.name,
            party=p,
            status=status,
            onboarded_on=onboarded,
            seed_key=key,
            jurisdiction=kw.pop("jurisdiction", p.jurisdiction or "AU"),
            **kw,
        )
        self.c[key] = c
        try:
            from clients import services

            services.rebuild_structure(self.org.id)
        except Exception:
            pass
        return c

    def refresh_structure(self) -> None:
        from clients import services

        services.rebuild_structure(self.org.id)

    def user(self, key: str = "co", role: str = "compliance_officer", name: str | None = None) -> User:
        u = User.objects.create_user(
            email=f"{key}-{uuid.uuid4().hex[:6]}@example.test",
            password="Kinroot-test-pass-1!",
            full_name=name or key.title(),
        )
        Membership.objects.create(org=self.org, user=u, role=role)
        self.users[key] = u
        return u

    def actor(self, key: str | None = None) -> Actor:
        if key is None:
            return Actor(org_id=self.org.id, user_id=None, name="System")
        u = self.users.get(key) or self.user(key)
        return Actor(org_id=self.org.id, user_id=u.id, name=u.full_name)

    def id(self, key: str) -> str:
        return str(self.p[key].id)


def harbour_quay(w: World) -> World:
    """Trust over company over offshore holding (contract seed #1, reduced)."""
    w.person("ava", "Ava Calder", birth_date=date(1972, 4, 9), nationality="AU", jurisdiction="AU")
    w.person("ben", "Ben Okafor", birth_date=date(1969, 2, 14), nationality="AU", jurisdiction="AU")
    w.party("trust", "trust", "Calder Family Trust", jurisdiction="AU")
    w.company("tco", "Calder Trustee Co Pty Ltd", identifiers={"acn": "604 123 451"})
    w.company("bell", "Bellmere Holdings Pty Ltd", identifiers={"acn": "612 345 678"})
    w.company(
        "kes",
        "Kestrel Ventures Ltd",
        jurisdiction="VG",
        address={"line1": "Suite 4, 88 Victoria St", "locality": "Mahe", "country": "SC"},
    )
    w.person(
        "pell",
        "Gregory Pell",
        jurisdiction="SC",
        is_nominee=True,
        address={"line1": "Suite 4, 88 Victoria St", "locality": "Mahe", "country": "SC"},
    )
    w.company("hq", "Harbour Quay Developments Pty Ltd", identifiers={"acn": "619 004 111"})
    w.own("ava", "trust", 100, interest="trust_entitlement")
    w.own("trust", "bell", 62)
    w.own("ben", "bell", 38)
    w.own("bell", "kes", 80, since="2020-03-01")
    w.own("kes", "hq", 100, since="2021-02-01")
    w.control("ava", "trust", "appointor")
    w.control("tco", "trust", "trustee")
    w.control("ava", "tco", "director")
    w.control("pell", "kes", "director", nominee=True)
    w.client("harbour-quay", "hq", services=["property_transaction", "managing_client_funds"], channel="intermediary")
    return w
