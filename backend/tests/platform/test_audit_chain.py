"""Per-organisation SHA-256 hash chain: append, verify, tamper detection, isolation."""

from __future__ import annotations

from datetime import timedelta

import pytest
from django.utils import timezone

from audit import api as audit
from audit.labels import label_for
from audit.models import AuditLog
from kinroot.contracts import Actor

pytestmark = pytest.mark.django_db


def actor(firm, role="compliance_officer"):
    user = firm["users"][role]
    return Actor(org_id=firm["org"].id, user_id=user.id, name=user.full_name, ip="10.0.0.1")


def test_record_appends_linked_rows(firm):
    first = audit.record(actor(firm), "client.created", resource_type="client", resource_id="c1")
    second = audit.record(actor(firm), "client.updated", resource_type="client", resource_id="c1")
    a, b = AuditLog.objects.get(id=first), AuditLog.objects.get(id=second)
    assert a.prev_hash == audit.GENESIS
    assert b.prev_hash == a.hash
    assert len(b.hash) == 64


def test_verify_valid_chain(firm):
    for i in range(5):
        audit.record(actor(firm), "client.updated", resource_id=str(i), metadata={"fields": ["name"]})
    assert audit.verify_chain(firm["org"].id) == {"valid": True, "checked": 5, "brokenAt": None}


def test_tampered_metadata_is_detected(firm):
    ids = [audit.record(actor(firm), "risk.overridden", metadata={"to": "low"}) for _ in range(3)]
    AuditLog.objects.filter(id=ids[1]).update(metadata={"to": "high"})
    result = audit.verify_chain(firm["org"].id)
    assert result["valid"] is False
    assert result["brokenAt"] == ids[1]
    assert result["checked"] == 1


def test_deleted_row_is_detected(firm):
    ids = [audit.record(actor(firm), "client.updated") for _ in range(3)]
    AuditLog.objects.filter(id=ids[1]).delete()
    result = audit.verify_chain(firm["org"].id)
    assert result["valid"] is False
    assert result["brokenAt"] == ids[2]


def test_chains_are_per_organisation(firm, other_firm):
    audit.record(actor(firm), "client.created")
    other = audit.record(actor(other_firm), "client.created")
    assert AuditLog.objects.get(id=other).prev_hash == audit.GENESIS
    assert audit.verify_chain(firm["org"].id)["checked"] == 1
    assert audit.verify_chain(other_firm["org"].id)["checked"] == 1


def test_restricted_rows_stay_in_the_chain(firm):
    audit.record(actor(firm), "client.created")
    audit.record(actor(firm), "case.opened", resource_type="case", restricted=True)
    audit.record(actor(firm), "client.updated")
    assert audit.verify_chain(firm["org"].id) == {"valid": True, "checked": 3, "brokenAt": None}
    assert AuditLog.objects.filter(restricted=True).count() == 1


def test_backdated_rows_verify(firm):
    past = timezone.now() - timedelta(days=400)
    audit.record(actor(firm), "client.created", at=past)
    audit.record(actor(firm), "client.submitted", at=past + timedelta(days=1))
    assert audit.verify_chain(firm["org"].id)["valid"] is True


def test_system_actor_and_metadata_are_canonical(firm):
    row = AuditLog.objects.get(
        id=audit.record(Actor(org_id=firm["org"].id, user_id=None), "monitoring.daily", metadata={"b": 1, "a": 2})
    )
    assert row.actor_type == "system"
    assert row.actor_name == "System"
    assert list(row.metadata) == ["a", "b"]


def test_labels_are_plain_language():
    assert label_for("client.submitted", client_name="Calder Family Trust") == (
        "Submitted Calder Family Trust for screening and risk assessment"
    )
    assert label_for("graph.rebuilt") == "Graph: rebuilt"
