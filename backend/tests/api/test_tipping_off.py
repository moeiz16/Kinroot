"""Tipping-off controls (ADR 0005): nobody outside the case learns of it through any response."""

from __future__ import annotations

import json
import uuid

import pytest

from api.sse import deliverable
from audit.models import AuditLog
from cases.models import Case
from clients.services import HOLD_MESSAGE, place_hold
from tests.api.helpers import make_client_record, signed_in

pytestmark = pytest.mark.django_db


@pytest.fixture
def case_setup(firm):
    client = make_client_record(firm, "Aurelian Shipping Pty Ltd", status="active")
    co = signed_in(firm["users"]["compliance_officer"])
    resp = co.post(
        "/api/v1/cases",
        {
            "clientId": str(client.id),
            "title": "Funds via free-zone parent",
            "grounds": "Third-party deposits from an unrelated UAE account.",
        },
        format="json",
    )
    assert resp.status_code == 201, resp.content
    case_id = resp.json()["id"]
    co.put(
        f"/api/v1/cases/{case_id}/access",
        {"entries": [{"userId": str(firm["users"]["partner"].id), "level": "summary"}]},
        format="json",
    )
    return {"client": client, "case_id": case_id, "co": co}


def _strip(body):
    body = dict(body)
    body.pop("requestId", None)
    return body


@pytest.mark.parametrize("role", ["owner", "fee_earner", "auditor"])
def test_non_members_get_the_same_404_as_unknown(firm, case_setup, role):
    api = signed_in(firm["users"][role])
    for suffix in ("", "/smr", "/timeline"):
        real = api.get(f"/api/v1/cases/{case_setup['case_id']}{suffix}")
        fake = api.get(f"/api/v1/cases/{uuid.uuid4()}{suffix}")
        assert real.status_code == fake.status_code == 404
        assert _strip(real.json()) == _strip(fake.json())
        assert real["Content-Length"] if real.has_header("Content-Length") else True


@pytest.mark.parametrize("role", ["owner", "fee_earner", "auditor"])
def test_non_members_see_an_empty_register(firm, case_setup, role):
    body = signed_in(firm["users"][role]).get("/api/v1/cases").json()
    assert body["total"] == 0
    assert body["items"] == []


def test_writes_by_non_members_are_404(firm, case_setup):
    api = signed_in(firm["users"]["fee_earner"])
    cid = case_setup["case_id"]
    assert api.patch(f"/api/v1/cases/{cid}", {"title": "x"}, format="json").status_code == 404
    assert api.put(f"/api/v1/cases/{cid}/smr", {"version": 0}, format="json").status_code == 404
    assert api.post(f"/api/v1/cases/{cid}/smr/submit").status_code == 404


def test_summary_member_sees_redacted_case(firm, case_setup):
    api = signed_in(firm["users"]["partner"])
    body = api.get(f"/api/v1/cases/{case_setup['case_id']}").json()
    assert body["accessLevel"] == "summary"
    assert body["grounds"] is None
    assert body["redactedFields"] == ["grounds", "narrative"]
    assert "access" not in body
    smr = api.get(f"/api/v1/cases/{case_setup['case_id']}/smr").json()
    assert smr["narrative"] is None
    assert smr["suspicionGrounds"] is None
    assert api.get("/api/v1/cases").json()["total"] == 1
    assert api.patch(f"/api/v1/cases/{case_setup['case_id']}", {"title": "x"}, format="json").status_code == 403


def test_full_member_sees_grounds_and_access_list(case_setup):
    body = case_setup["co"].get(f"/api/v1/cases/{case_setup['case_id']}").json()
    assert body["grounds"].startswith("Third-party")
    assert body["redactedFields"] == []
    assert {a["level"] for a in body["access"]} == {"full", "summary"}


def test_client_record_never_shows_case(firm, case_setup):
    api = signed_in(firm["users"]["fee_earner"])
    body = api.get(f"/api/v1/clients/{case_setup['client'].id}").json()
    text = json.dumps(body).lower()
    assert "case" not in text
    assert "smr" not in text
    assert "suspic" not in text
    assert body["flags"] == [] or "case" not in body["flags"]


def test_held_wording_is_identical_for_case_and_manual_holds(firm, case_setup):
    other = make_client_record(firm, "Brightwater Realty Pty Ltd", status="active")
    place_hold(other, "manual", note="Awaiting documents")
    api = signed_in(firm["users"]["fee_earner"])
    msg = {"kind": "information_request", "message": "Please confirm the paying entity."}
    a = api.post(f"/api/v1/clients/{case_setup['client'].id}/communications", msg, format="json")
    b = api.post(f"/api/v1/clients/{other.id}/communications", msg, format="json")
    assert a.status_code == b.status_code == 409
    assert _strip(a.json()) == _strip(b.json())
    assert a.json()["detail"] == HOLD_MESSAGE
    exit_resp = api.post(f"/api/v1/clients/{case_setup['client'].id}/exit", {"reason": "Done"}, format="json")
    assert _strip(exit_resp.json()) == _strip(b.json())


def test_restricted_audit_rows_hidden_without_smr_read(firm, case_setup):
    for role in ("owner", "auditor"):
        rows = signed_in(firm["users"][role]).get("/api/v1/audit?pageSize=200").json()["items"]
        assert not any(r["action"].startswith(("case.", "smr.", "concern.")) for r in rows)
        assert not any(r["resourceType"] == "case" for r in rows)
    officer_rows = case_setup["co"].get("/api/v1/audit?pageSize=200").json()["items"]
    assert any(r["action"] == "case.opened" for r in officer_rows)
    assert AuditLog.objects.filter(action="case.opened", restricted=True).count() == 1


def test_csv_export_hides_restricted_rows(firm, case_setup):
    csv_body = signed_in(firm["users"]["owner"]).get("/api/v1/audit/export.csv").content.decode()
    assert "case.opened" not in csv_body


def test_dashboard_omits_case_counts(firm, case_setup):
    for role in ("owner", "partner", "fee_earner", "auditor"):
        body = signed_in(firm["users"][role]).get("/api/v1/dashboard").json()
        assert "smrDrafts" not in body["counts"]
        assert "case" not in json.dumps(body["recentActivity"]).lower()
    assert "smrDrafts" in case_setup["co"].get("/api/v1/dashboard").json()["counts"]


def test_case_events_reach_only_the_case_audience(firm, case_setup):
    org_id = firm["org"].id
    for role, expected in (("fee_earner", 0), ("owner", 0), ("partner", 1), ("compliance_officer", 1)):
        user = firm["users"][role]
        from accounts.roles import permissions_for

        events = [e for e in deliverable(org_id, user.id, permissions_for(role), 0) if e.name == "case.updated"]
        assert (len(events) >= 1) == bool(expected), role


def test_concerns_are_one_way(firm):
    client = make_client_record(firm, "Lumen Trade Pty Ltd")
    tom = signed_in(firm["users"]["fee_earner"])
    resp = tom.post(
        "/api/v1/concerns",
        {
            "clientId": str(client.id),
            "summary": "Director seems to be a stand-in",
            "details": "Defers every question to an overseas contact.",
        },
        format="json",
    )
    assert resp.status_code == 201
    assert set(resp.json()) == {"id", "receivedAt", "message"}
    mine = tom.get("/api/v1/concerns/mine").json()
    assert mine == [{"id": resp.json()["id"], "receivedAt": mine[0]["receivedAt"], "status": "received"}]
    assert tom.get("/api/v1/concerns").status_code == 403
    officer = signed_in(firm["users"]["compliance_officer"]).get("/api/v1/concerns").json()
    assert officer[0]["summary"] == "Director seems to be a stand-in"
    co = signed_in(firm["users"]["compliance_officer"])
    co.post(
        "/api/v1/cases",
        {
            "clientId": str(client.id),
            "title": "Nominee",
            "grounds": "Nominee director concerns.",
            "concernIds": [resp.json()["id"]],
        },
        format="json",
    )
    assert tom.get("/api/v1/concerns/mine").json()[0]["status"] == "received"


def test_auditor_cannot_raise_concerns(firm):
    resp = signed_in(firm["users"]["auditor"]).post("/api/v1/concerns", {"summary": "Something odd"}, format="json")
    assert resp.status_code == 403


def test_assistant_never_receives_case_permissions(firm, monkeypatch):
    from assistant import api as assistant_api

    seen = {}

    def fake_ask(org_id, question, actor, *, permissions, client_id=None, as_of=None):
        seen["perms"] = permissions
        raise NotImplementedError

    monkeypatch.setattr(assistant_api, "ask", fake_ask)
    signed_in(firm["users"]["compliance_officer"]).post(
        "/api/v1/assistant/ask", {"question": "Who controls X?"}, format="json"
    )
    assert seen["perms"]
    assert not (seen["perms"] & {"smr:read", "smr:write", "smr:submit"})


def test_smr_draft_versioning_and_submit(firm, case_setup):
    co, cid = case_setup["co"], case_setup["case_id"]
    party_id = str(case_setup["client"].party_id)
    draft = {
        "version": 0,
        "suspicionGrounds": "Unexplained third-party funds.",
        "narrative": "We act for ...",
        "subjects": [{"partyId": party_id, "role": "Client"}],
        "transactions": [{"date": "2025-10-01", "amount": "1100000.00", "currency": "AUD", "description": "Deposit"}],
    }
    first = co.put(f"/api/v1/cases/{cid}/smr", draft, format="json")
    assert first.status_code == 200
    assert first.json()["version"] == 1
    stale = co.put(f"/api/v1/cases/{cid}/smr", draft, format="json")
    assert stale.status_code == 409
    assert stale.json()["code"] == "stale_version"
    submitted = co.post(f"/api/v1/cases/{cid}/smr/submit")
    assert submitted.status_code == 200
    assert submitted.json()["reference"].startswith("DEMO-SMR-")
    assert Case.objects.get(id=cid).status == "reported"
    assert co.post(f"/api/v1/cases/{cid}/smr/submit").status_code == 409


def test_submit_requires_complete_draft(case_setup):
    resp = case_setup["co"].post(f"/api/v1/cases/{case_setup['case_id']}/smr/submit")
    assert resp.status_code == 422


def test_closing_case_releases_its_hold(firm, case_setup):
    co = case_setup["co"]
    co.patch(f"/api/v1/cases/{case_setup['case_id']}", {"status": "closed_no_report"}, format="json")
    api = signed_in(firm["users"]["fee_earner"])
    resp = api.post(
        f"/api/v1/clients/{case_setup['client'].id}/communications",
        {"kind": "information_request", "message": "Please confirm."},
        format="json",
    )
    assert resp.status_code == 202


def test_case_deadline_is_three_business_days(case_setup):
    from datetime import date

    body = case_setup["co"].get(f"/api/v1/cases/{case_setup['case_id']}").json()
    opened = date.fromisoformat(body["openedAt"][:10])
    deadline = date.fromisoformat(body["deadlineOn"])
    assert 3 <= (deadline - opened).days <= 5


def test_timeline_for_members(firm, case_setup):
    rows = signed_in(firm["users"]["partner"]).get(f"/api/v1/cases/{case_setup['case_id']}/timeline").json()
    assert [r["action"] for r in rows][:2] == ["case.opened", "case.access_changed"]
    assert rows[0]["label"] == "Case opened"
