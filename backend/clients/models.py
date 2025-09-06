"""Clients: the system of record for parties, ownership/control relationships, clients and CDD evidence.

Owner: builder A. Shapes follow docs/API_CONTRACT.md Part 2. The graph app projects Party and Relationship
through its own post_save/post_delete signals (ADR 0002); the domain core reads these models but never writes
them (it calls clients.api instead).
"""

from __future__ import annotations

import uuid

from django.conf import settings
from django.db import models

ORG = "accounts.Organisation"
USER = settings.AUTH_USER_MODEL

PARTY_KINDS = [
    ("person", "Person"),
    ("company", "Company"),
    ("trust", "Trust"),
    ("partnership", "Partnership"),
    ("other", "Other"),
]
CLIENT_KINDS = [
    ("individual", "Individual"),
    ("company", "Company"),
    ("trust", "Trust"),
    ("partnership", "Partnership"),
]
SOURCES = [
    ("manual", "Manual"),
    ("uk_ch", "Companies House"),
    ("au_abr", "ABN Lookup"),
    ("seed", "Sample"),
    ("import", "Import"),
]


class Party(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    org = models.ForeignKey(ORG, on_delete=models.CASCADE, related_name="+")
    kind = models.CharField(max_length=12, choices=PARTY_KINDS)
    name = models.CharField(max_length=300)
    normalized_name = models.CharField(max_length=300, db_index=True, blank=True, default="")
    given_names = models.CharField(max_length=200, blank=True, default="")
    family_name = models.CharField(max_length=200, blank=True, default="")
    birth_date = models.DateField(null=True, blank=True)
    nationality = models.CharField(max_length=2, blank=True, default="")
    jurisdiction = models.CharField(max_length=2, blank=True, default="")
    identifiers = models.JSONField(default=dict, blank=True)  # {acn, abn, ukCompanyNumber}
    address = models.JSONField(default=dict, blank=True)  # {line1, locality, state, postcode, country}
    is_nominee = models.BooleanField(default=False)
    dormant = models.BooleanField(default=False)
    source = models.CharField(max_length=10, choices=SOURCES, default="manual")
    source_ref = models.CharField(max_length=200, blank=True, default="")
    merged_into = models.ForeignKey(
        "self", null=True, blank=True, on_delete=models.SET_NULL, related_name="merged_records"
    )
    merge_moves = models.JSONField(default=dict, blank=True)  # rows re-pointed by a merge, so it can be split
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["name"]
        indexes = [models.Index(fields=["org", "kind"]), models.Index(fields=["org", "merged_into"])]

    def __str__(self) -> str:
        return self.name


class Relationship(models.Model):
    KINDS = [("ownership", "Ownership"), ("control", "Control")]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    org = models.ForeignKey(ORG, on_delete=models.CASCADE, related_name="+")
    from_party = models.ForeignKey(Party, on_delete=models.CASCADE, related_name="outgoing")
    to_party = models.ForeignKey(Party, on_delete=models.CASCADE, related_name="incoming")
    kind = models.CharField(max_length=10, choices=KINDS)
    pct = models.FloatField(null=True, blank=True)  # ownership only, 0 < pct <= 100
    interest = models.CharField(max_length=20, blank=True, default="")
    role = models.CharField(max_length=30, blank=True, default="")  # control only
    nominee = models.BooleanField(default=False)
    valid_from = models.DateField()
    valid_to = models.DateField(null=True, blank=True)
    source = models.CharField(max_length=10, choices=SOURCES, default="manual")
    source_ref = models.CharField(max_length=200, blank=True, default="")
    evidence_note = models.CharField(max_length=500, blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["valid_from"]
        indexes = [models.Index(fields=["org", "to_party"]), models.Index(fields=["org", "from_party"])]

    def __str__(self) -> str:
        return f"{self.kind} {self.from_party_id} -> {self.to_party_id}"


class Client(models.Model):
    STATUSES = [("onboarding", "Onboarding"), ("active", "Active"), ("blocked", "Blocked"), ("exited", "Exited")]
    CHANNELS = [("face_to_face", "Face to face"), ("remote", "Remote"), ("intermediary", "Intermediary")]
    RATINGS = [("low", "Low"), ("medium", "Medium"), ("high", "High")]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    org = models.ForeignKey(ORG, on_delete=models.CASCADE, related_name="+")
    kind = models.CharField(max_length=12, choices=CLIENT_KINDS)
    name = models.CharField(max_length=300)
    status = models.CharField(max_length=12, choices=STATUSES, default="onboarding")
    party = models.ForeignKey(Party, on_delete=models.PROTECT, related_name="client_records")
    jurisdiction = models.CharField(max_length=2, default="AU")
    services = models.JSONField(default=list, blank=True)
    channel = models.CharField(max_length=14, choices=CHANNELS, default="face_to_face")
    matter_reference = models.CharField(max_length=80, blank=True, default="")
    assigned_to = models.ForeignKey(USER, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    rating = models.CharField(max_length=6, choices=RATINGS, null=True, blank=True)  # noqa: DJ001
    rating_source = models.CharField(max_length=10, null=True, blank=True)  # noqa: DJ001 - rules | override
    edd_required = models.BooleanField(default=False)
    onboarded_on = models.DateField(null=True, blank=True)
    last_reviewed_on = models.DateField(null=True, blank=True)
    next_review_on = models.DateField(null=True, blank=True)
    relationship_ended_on = models.DateField(null=True, blank=True)
    legal_hold = models.BooleanField(default=False)
    blocked_reason = models.CharField(max_length=40, blank=True, default="")
    exit_reason = models.CharField(max_length=500, blank=True, default="")
    anonymised_at = models.DateTimeField(null=True, blank=True)
    submitted_at = models.DateTimeField(null=True, blank=True)
    ubo_count = models.IntegerField(null=True, blank=True)  # cached from the UBO engine for list views
    seed_key = models.CharField(max_length=60, null=True, blank=True)  # noqa: DJ001  # stable sample-data id (tests, eval)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["name"]
        constraints = [models.UniqueConstraint(fields=["org", "seed_key"], name="uniq_client_seed_key")]
        indexes = [models.Index(fields=["org", "status"]), models.Index(fields=["org", "rating"])]

    def __str__(self) -> str:
        return self.name


class ClientParty(models.Model):
    """A party in a client's structure (owners and controllers, transitively). Maintained by clients.services."""

    id = models.BigAutoField(primary_key=True)
    org = models.ForeignKey(ORG, on_delete=models.CASCADE, related_name="+")
    client = models.ForeignKey(Client, on_delete=models.CASCADE, related_name="structure_links")
    party = models.ForeignKey(Party, on_delete=models.CASCADE, related_name="client_links")
    level = models.IntegerField(default=0)  # hops from the client's own party

    class Meta:
        constraints = [models.UniqueConstraint(fields=["client", "party"], name="uniq_client_party")]

    def __str__(self) -> str:
        return f"{self.party_id} in {self.client_id}"


class Document(models.Model):
    DOC_TYPES = [
        ("passport", "Passport"),
        ("drivers_licence", "Driver licence"),
        ("birth_certificate", "Birth certificate"),
        ("trust_deed", "Trust deed"),
        ("company_extract", "Company extract"),
        ("other", "Other"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    org = models.ForeignKey(ORG, on_delete=models.CASCADE, related_name="+")
    client = models.ForeignKey(Client, on_delete=models.CASCADE, related_name="documents")
    party = models.ForeignKey(Party, on_delete=models.CASCADE, related_name="documents")
    doc_type = models.CharField(max_length=20, choices=DOC_TYPES)
    file = models.FileField(upload_to="documents/%Y/%m/", max_length=300)
    file_name = models.CharField(max_length=200)
    content_type = models.CharField(max_length=60)
    sha256 = models.CharField(max_length=64)
    size = models.IntegerField()
    uploaded_by = models.ForeignKey(USER, null=True, on_delete=models.SET_NULL, related_name="+")
    retain_until = models.DateField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self) -> str:
        return f"{self.doc_type} {self.id}"


class VerificationCheck(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    org = models.ForeignKey(ORG, on_delete=models.CASCADE, related_name="+")
    client = models.ForeignKey(Client, on_delete=models.CASCADE, related_name="verifications")
    party = models.ForeignKey(Party, on_delete=models.CASCADE, related_name="verifications")
    method = models.CharField(max_length=12)  # document | electronic
    result = models.CharField(max_length=10)  # verified | partial | failed
    sources = models.JSONField(default=list)
    document_ids = models.JSONField(default=list)
    reference = models.CharField(max_length=40)
    checked_by = models.ForeignKey(USER, null=True, on_delete=models.SET_NULL, related_name="+")
    checked_at = models.DateTimeField()

    class Meta:
        ordering = ["-checked_at"]

    def __str__(self) -> str:
        return self.reference


class Consent(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    org = models.ForeignKey(ORG, on_delete=models.CASCADE, related_name="+")
    client = models.ForeignKey(Client, on_delete=models.CASCADE, related_name="consents")
    party = models.ForeignKey(Party, on_delete=models.CASCADE, related_name="consents")
    purpose = models.CharField(max_length=30)
    given_on = models.DateField()
    method = models.CharField(max_length=60)
    recorded_by = models.ForeignKey(USER, null=True, on_delete=models.SET_NULL, related_name="+")
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self) -> str:
        return f"Consent {self.purpose} for {self.party_id}"


class EddCase(models.Model):
    STATUSES = [
        ("not_required", "Not required"),
        ("in_progress", "In progress"),
        ("awaiting_compliance", "Awaiting compliance sign-off"),
        ("awaiting_senior", "Awaiting senior approval"),
        ("approved", "Approved"),
        ("rejected", "Rejected"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    org = models.ForeignKey(ORG, on_delete=models.CASCADE, related_name="+")
    client = models.OneToOneField(Client, on_delete=models.CASCADE, related_name="edd")
    required = models.BooleanField(default=False)
    triggers = models.JSONField(default=list)  # [EddTrigger]
    status = models.CharField(max_length=20, choices=STATUSES, default="not_required")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self) -> str:
        return f"EDD for {self.client_id} ({self.status})"


class EddMeasure(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    org = models.ForeignKey(ORG, on_delete=models.CASCADE, related_name="+")
    edd = models.ForeignKey(EddCase, on_delete=models.CASCADE, related_name="measures")
    key = models.CharField(max_length=40)
    status = models.CharField(max_length=16, default="todo")  # todo | done | not_applicable
    note = models.TextField(blank=True, default="")
    document_ids = models.JSONField(default=list)
    completed_by = models.ForeignKey(USER, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    completed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["edd", "key"], name="uniq_edd_measure")]

    def __str__(self) -> str:
        return f"{self.key}: {self.status}"


class SignOff(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    org = models.ForeignKey(ORG, on_delete=models.CASCADE, related_name="+")
    edd = models.ForeignKey(EddCase, on_delete=models.CASCADE, related_name="signoffs")
    stage = models.CharField(max_length=12)  # compliance | senior
    decision = models.CharField(max_length=8)  # approve | reject
    note = models.TextField(blank=True, default="")
    by = models.ForeignKey(USER, null=True, on_delete=models.SET_NULL, related_name="+")
    at = models.DateTimeField()
    superseded = models.BooleanField(default=False)  # earlier round after EDD was reopened

    class Meta:
        ordering = ["at"]

    def __str__(self) -> str:
        return f"{self.stage} {self.decision}"


class Communication(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    org = models.ForeignKey(ORG, on_delete=models.CASCADE, related_name="+")
    client = models.ForeignKey(Client, on_delete=models.CASCADE, related_name="communications")
    kind = models.CharField(max_length=24)  # information_request | exit_notice
    message = models.TextField()
    status = models.CharField(max_length=6)  # sent | held
    held_reason_code = models.CharField(max_length=40, blank=True, default="")
    sent_by = models.ForeignKey(USER, null=True, on_delete=models.SET_NULL, related_name="+")
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self) -> str:
        return f"{self.kind} ({self.status})"


class ClientHold(models.Model):
    """A hold on client-facing steps. Reason codes are internal; every hold answers with the same neutral wording."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    org = models.ForeignKey(ORG, on_delete=models.CASCADE, related_name="+")
    client = models.ForeignKey(Client, on_delete=models.CASCADE, related_name="holds")
    reason_code = models.CharField(max_length=40)  # manual | restricted (case) | edd_pending
    source_ref = models.CharField(max_length=64, blank=True, default="")
    note = models.TextField(blank=True, default="")
    placed_by = models.ForeignKey(USER, null=True, on_delete=models.SET_NULL, related_name="+")
    created_at = models.DateTimeField(auto_now_add=True)
    released_at = models.DateTimeField(null=True, blank=True)
    released_by = models.ForeignKey(USER, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    release_note = models.TextField(blank=True, default="")

    def __str__(self) -> str:
        return f"Hold {self.id}"
