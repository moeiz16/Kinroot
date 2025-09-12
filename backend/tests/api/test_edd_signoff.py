"""EDD measures and two-stage sign-off (contract §1.10)."""

from __future__ import annotations

import pytest
from django.utils import timezone

from clients.models import Client, Consent, EddCase, VerificationCheck
from kinroot.contracts import EddTrigger
from risk import api as risk_api
from tests.api.helpers import make_client_record, signed_in

pytestmark = pytest.mark.django_db

PEP = [EddTrigger(code="pep", message="Politically exposed person", measures=["source_of_wealth", "source_of_funds"])]
STRUCTURE = [EddTrigger(code="complex_structure", message="Three or more layers", measures=["ubo_verification"])]


@pytest.fixture
def triggers(monkeypatch):
    current = {"value": PEP}
    monkeypatch.setattr(risk_api, "edd_requirements", lambda org_id, client_id: current["value"])
    return current


@pytest.fixture
def pep_client(firm, triggers):
    client = make_client_record(firm, "Julian Whitfield", kind="individual", assigned="fee_earner")
    return client


def test_edd_is_built_from_triggers(as_role, pep_client):
    body = as_role("fee_earner").get(f"/api/v1/clients/{pep_client.id}/edd").json()
    assert body["required"] is True
    assert body["status"] == "in_progress"
    assert [m["key"] for m in body["measures"]] == ["source_of_wealth", "source_of_funds", "senior_approval"]
    assert body["measures"][0]["label"] == "Source of wealth established"
    assert Client.objects.get(id=pep_client.id).edd_required is True


def test_measures_then_compliance_then_senior(firm, as_role, pep_client):
    fee = as_role("fee_earner")
    for key in ("source_of_wealth", "source_of_funds"):
        resp = fee.post(
            f"/api/v1/clients/{pep_client.id}/edd/measures/{key}",
            {"status": "done", "note": "Bank statements reviewed"},
            format="json",
        )
        assert resp.status_code == 200
    assert resp.json()["status"] == "awaiting_compliance"
    co = as_role("compliance_officer")
    wrong_stage = co.post(
        f"/api/v1/clients/{pep_client.id}/signoff",
        {"stage": "senior", "decision": "approve", "note": "ok"},
        format="json",
    )
    assert wrong_stage.status_code == 403
    resp = co.post(
        f"/api/v1/clients/{pep_client.id}/signoff",
        {"stage": "compliance", "decision": "approve", "note": "Evidence accepted"},
        format="json",
    )
    assert resp.json()["status"] == "awaiting_senior"
    queue = as_role("partner").get("/api/v1/signoffs?stage=senior").json()
    assert [q["clientId"] for q in queue] == [str(pep_client.id)]
    resp = as_role("partner").post(
        f"/api/v1/clients/{pep_client.id}/signoff",
        {"stage": "senior", "decision": "approve", "note": "Approved"},
        format="json",
    )
    body = resp.json()
    assert body["status"] == "approved"
    assert [s["stage"] for s in body["signoffs"]] == ["compliance", "senior"]
    assert next(m for m in body["measures"] if m["key"] == "senior_approval")["status"] == "done"


def test_partner_cannot_approve_own_client(firm, triggers):
    client = make_client_record(firm, "Own Client", kind="individual", assigned="partner")
    edd = EddCase.objects.create(
        org=firm["org"],
        client=client,
        required=True,
        status="awaiting_senior",
        triggers=[{"code": "pep", "message": "", "measures": []}],
    )
    assert edd
    triggers["value"] = PEP
    resp = signed_in(firm["users"]["partner"]).post(
        f"/api/v1/clients/{client.id}/signoff", {"stage": "senior", "decision": "approve", "note": "x"}, format="json"
    )
    assert resp.status_code == 403
    assert "own client" in resp.json()["detail"]


def test_signoff_out_of_order_is_invalid(as_role, pep_client):
    as_role("fee_earner").get(f"/api/v1/clients/{pep_client.id}/edd")
    resp = as_role("compliance_officer").post(
        f"/api/v1/clients/{pep_client.id}/signoff", {"stage": "compliance", "decision": "approve"}, format="json"
    )
    assert resp.status_code == 422
    assert resp.json()["code"] == "invalid_transition"


def test_reject_needs_reason_and_reopens(as_role, pep_client):
    fee = as_role("fee_earner")
    for key in ("source_of_wealth", "source_of_funds"):
        fee.post(f"/api/v1/clients/{pep_client.id}/edd/measures/{key}", {"status": "done"}, format="json")
    co = as_role("compliance_officer")
    bad = co.post(
        f"/api/v1/clients/{pep_client.id}/signoff", {"stage": "compliance", "decision": "reject"}, format="json"
    )
    assert bad.status_code == 422
    resp = co.post(
        f"/api/v1/clients/{pep_client.id}/signoff",
        {"stage": "compliance", "decision": "reject", "note": "Source of wealth evidence is thin."},
        format="json",
    )
    assert resp.json()["status"] == "rejected"
    reopened = fee.post(
        f"/api/v1/clients/{pep_client.id}/edd/measures/source_of_wealth",
        {"status": "done", "note": "Added tax returns"},
        format="json",
    ).json()
    assert reopened["status"] == "awaiting_compliance"
    assert reopened["signoffs"] == []


def test_measure_rules(as_role, pep_client):
    fee = as_role("fee_earner")
    fee.get(f"/api/v1/clients/{pep_client.id}/edd")
    assert (
        fee.post(
            f"/api/v1/clients/{pep_client.id}/edd/measures/senior_approval", {"status": "done"}, format="json"
        ).status_code
        == 422
    )
    assert (
        fee.post(f"/api/v1/clients/{pep_client.id}/edd/measures/unknown", {"status": "done"}, format="json").status_code
        == 404
    )
    na = fee.post(
        f"/api/v1/clients/{pep_client.id}/edd/measures/source_of_funds", {"status": "not_applicable"}, format="json"
    )
    assert na.status_code == 422
    assert (
        as_role("auditor")
        .post(f"/api/v1/clients/{pep_client.id}/edd/measures/source_of_funds", {"status": "done"}, format="json")
        .status_code
        == 403
    )


def test_no_senior_stage_without_senior_trigger(firm, triggers):
    triggers["value"] = STRUCTURE
    client = make_client_record(firm, "Delacroix Unit Trust", kind="trust")
    fee = signed_in(firm["users"]["fee_earner"])
    fee.post(f"/api/v1/clients/{client.id}/edd/measures/ubo_verification", {"status": "done"}, format="json")
    body = (
        signed_in(firm["users"]["compliance_officer"])
        .post(f"/api/v1/clients/{client.id}/signoff", {"stage": "compliance", "decision": "approve"}, format="json")
        .json()
    )
    assert body["status"] == "approved"


def test_approval_activates_submitted_client(firm, pep_client, monkeypatch):
    from graph import api as graph_api
    from screening import api as screening_api

    monkeypatch.setattr(graph_api, "beneficial_owners", lambda *a, **k: (_ for _ in ()).throw(NotImplementedError()))
    monkeypatch.setattr(screening_api, "list_hits", lambda *a, **k: (_ for _ in ()).throw(NotImplementedError()))
    Consent.objects.create(
        org=firm["org"],
        client=pep_client,
        party=pep_client.party,
        purpose="identity_verification",
        given_on=timezone.localdate(),
        method="Signed",
    )
    VerificationCheck.objects.create(
        org=firm["org"],
        client=pep_client,
        party=pep_client.party,
        method="document",
        result="verified",
        reference="MOCK-DVS-2",
        checked_at=timezone.now(),
    )
    Client.objects.filter(id=pep_client.id).update(submitted_at=timezone.now(), rating="high")
    fee = signed_in(firm["users"]["fee_earner"])
    for key in ("source_of_wealth", "source_of_funds"):
        fee.post(f"/api/v1/clients/{pep_client.id}/edd/measures/{key}", {"status": "done"}, format="json")
    signed_in(firm["users"]["compliance_officer"]).post(
        f"/api/v1/clients/{pep_client.id}/signoff", {"stage": "compliance", "decision": "approve"}, format="json"
    )
    signed_in(firm["users"]["partner"]).post(
        f"/api/v1/clients/{pep_client.id}/signoff", {"stage": "senior", "decision": "approve"}, format="json"
    )
    client = Client.objects.get(id=pep_client.id)
    assert client.status == "active"
    assert client.onboarded_on == timezone.localdate()


def test_signoff_queue_requires_signoff_permission(as_role):
    assert as_role("fee_earner").get("/api/v1/signoffs").status_code == 403
    assert as_role("compliance_officer").get("/api/v1/signoffs").json() == []
