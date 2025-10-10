"""Endpoints backed by the domain core: wiring, permission gates, error mapping and wire shapes."""

from __future__ import annotations

import pytest

from graph import api as graph_api
from kinroot.contracts import DomainConflict, MergeOutcome, NotFound
from monitoring import api as monitoring_api
from resolution import api as resolution_api
from risk import api as risk_api
from screening import api as screening_api
from tests.api import fakes
from tests.api.helpers import make_client_record

pytestmark = pytest.mark.django_db


def test_client_graph_is_graphology(as_role, client_record, monkeypatch):
    seen = {}

    def fake(org_id, client_id, *, as_of=None, depth=6):
        seen.update(as_of=as_of, depth=depth)
        return fakes.graph_view(str(client_id))

    monkeypatch.setattr(graph_api, "client_graph", fake)
    body = as_role("fee_earner").get(f"/api/v1/clients/{client_record.id}/graph?asOf=2024-06-30&depth=4").json()
    assert body["attributes"] == {
        "focusId": str(client_record.id),
        "asOf": "2025-10-01",
        "depth": 6,
        "truncated": False,
        "graphVersion": 7,
    }
    node = body["nodes"][0]
    assert node["key"] == str(client_record.id)
    assert node["attributes"]["clientId"] == "c1"
    assert node["attributes"]["mergedCount"] == 0
    assert node["attributes"]["identifiers"] == {"acn": "612 345 670"}
    edge = body["edges"][0]
    assert edge["source"] == "n2"
    assert edge["attributes"]["validFrom"] == "2019-06-01"
    assert edge["attributes"]["sourceRef"] == "manual"
    assert str(seen["as_of"]) == "2024-06-30"
    assert seen["depth"] == 4


def test_bad_as_of_is_400(as_role, client_record):
    resp = as_role("fee_earner").get(f"/api/v1/clients/{client_record.id}/graph?asOf=yesterday")
    assert resp.status_code == 400
    assert resp.json()["code"] == "bad_request"


def test_domain_not_implemented_maps_to_503(as_role, client_record, monkeypatch):
    def unavailable(*a, **k):
        raise NotImplementedError

    monkeypatch.setattr(graph_api, "clusters", unavailable)
    resp = as_role("auditor").get("/api/v1/graph/clusters")
    assert resp.status_code == 503
    assert resp.json()["code"] == "unavailable"
    assert resp["Retry-After"] == "30"


def test_domain_not_found_maps_to_404(as_role, monkeypatch):
    def missing(*a, **k):
        raise NotFound("hit")

    monkeypatch.setattr(screening_api, "get_hit", missing)
    resp = as_role("fee_earner").get("/api/v1/screening/hits/22222222-2222-2222-2222-222222222222")
    assert resp.status_code == 404


def test_hit_review_reason_hidden_until_decided(as_role, client_record, monkeypatch):
    escalated = fakes.hit(str(client_record.id), status="escalated", reason="Referred to the compliance officer")
    decided = fakes.hit(
        str(client_record.id),
        status="false_positive",
        reason="Different birth year",
        hit_id="33333333-3333-3333-3333-333333333333",
    )
    monkeypatch.setattr(screening_api, "list_hits", lambda *a, **k: fakes.page([escalated, decided]))
    fee = as_role("fee_earner").get("/api/v1/screening/hits?status=all").json()["items"]
    assert fee[0]["reviewReason"] is None
    assert fee[1]["reviewReason"] == "Different birth year"
    co = as_role("compliance_officer").get("/api/v1/screening/hits?status=all").json()["items"]
    assert co[0]["reviewReason"] == "Referred to the compliance officer"


def test_hit_review_validation_and_conflict(as_role, client_record, monkeypatch):
    co = as_role("compliance_officer")
    url = "/api/v1/screening/hits/11111111-1111-1111-1111-111111111111/review"
    assert co.post(url, {"decision": "true_match", "reason": "short"}, format="json").status_code == 422

    def decided(*a, **k):
        raise DomainConflict("already_decided", "This match has already been reviewed.")

    monkeypatch.setattr(screening_api, "review_hit", decided)
    resp = co.post(url, {"decision": "true_match", "reason": "Same person confirmed"}, format="json")
    assert resp.status_code == 409
    assert resp.json()["code"] == "already_decided"
    assert (
        as_role("fee_earner")
        .post(url, {"decision": "true_match", "reason": "Same person confirmed"}, format="json")
        .status_code
        == 403
    )


def test_hit_review_passes_actor(as_role, client_record, firm, monkeypatch):
    calls = {}

    def review(org_id, hit_id, decision, reason, actor):
        calls.update(decision=decision, actor=actor)
        return fakes.hit(str(client_record.id), status="false_positive", reason=reason)

    monkeypatch.setattr(screening_api, "review_hit", review)
    resp = as_role("compliance_officer").post(
        "/api/v1/screening/hits/11111111-1111-1111-1111-111111111111/review",
        {"decision": "false_positive", "reason": "Different birth year"},
        format="json",
    )
    assert resp.status_code == 200
    assert calls["actor"].user_id == firm["users"]["compliance_officer"].id
    assert calls["actor"].org_id == firm["org"].id


def test_screen_client_unavailable_until_handler_registered(as_role, client_record):
    resp = as_role("fee_earner").post(f"/api/v1/clients/{client_record.id}/screen")
    assert resp.status_code in (202, 503)


def test_resolution_decision(as_role, monkeypatch):
    monkeypatch.setattr(
        resolution_api,
        "decide",
        lambda org, cid, decision, actor, note="": MergeOutcome(
            candidate_id=str(cid), survivor_id="s1", merged_ids=["m1"], status="merged"
        ),
    )
    co = as_role("compliance_officer")
    resp = co.post(
        "/api/v1/resolution/candidates/44444444-4444-4444-4444-444444444444/decision",
        {"decision": "merge", "note": "Same DOB and address"},
        format="json",
    )
    assert resp.json() == {
        "candidateId": "44444444-4444-4444-4444-444444444444",
        "survivorId": "s1",
        "mergedIds": ["m1"],
        "status": "merged",
    }
    assert (
        as_role("partner")
        .post(
            "/api/v1/resolution/candidates/44444444-4444-4444-4444-444444444444/decision",
            {"decision": "merge"},
            format="json",
        )
        .status_code
        == 403
    )
    assert co.post("/api/v1/resolution/candidates/x/decision", {"decision": "maybe"}, format="json").status_code == 422


def test_resolution_list_validates_filters(as_role):
    co = as_role("compliance_officer")
    assert co.get("/api/v1/resolution/candidates?status=bogus").status_code == 422
    assert as_role("fee_earner").get("/api/v1/resolution/candidates").status_code == 403


def test_propose_requires_two_parties_of_this_firm(as_role, client_record, other_firm):
    theirs = make_client_record(other_firm, "Penrose Bakeries Ltd")
    resp = as_role("fee_earner").post(
        "/api/v1/resolution/propose",
        {"leftId": str(client_record.party_id), "rightId": str(theirs.party_id)},
        format="json",
    )
    assert resp.status_code == 404
    same = as_role("fee_earner").post(
        "/api/v1/resolution/propose",
        {"leftId": str(client_record.party_id), "rightId": str(client_record.party_id)},
        format="json",
    )
    assert same.status_code == 422


def test_risk_override_lowering_needs_reason(as_role, firm, monkeypatch):
    client = make_client_record(firm, "Tasman Ridge Pty Ltd", rating="high")
    monkeypatch.setattr(risk_api, "override_rating", lambda *a, **k: None)
    co = as_role("compliance_officer")
    short = co.post(
        f"/api/v1/clients/{client.id}/risk/override", {"rating": "low", "reason": "Fine now"}, format="json"
    )
    assert short.status_code == 422
    ok = co.post(
        f"/api/v1/clients/{client.id}/risk/override",
        {"rating": "low", "reason": "Cycle unwound; registry extract shows a single owner."},
        format="json",
    )
    assert ok.status_code == 200
    assert (
        as_role("partner")
        .post(f"/api/v1/clients/{client.id}/risk/override", {"rating": "high", "reason": "Raising"}, format="json")
        .status_code
        == 403
    )


def test_models_promote_validates_name(as_role):
    co = as_role("compliance_officer")
    assert co.post("/api/v1/models/gpt/promote", {"version": "1", "note": "x" * 10}, format="json").status_code == 404
    assert as_role("fee_earner").get("/api/v1/models").status_code == 403


def test_alerts_list_and_resolve(as_role, client_record, monkeypatch):
    monkeypatch.setattr(monitoring_api, "list_alerts", lambda *a, **k: fakes.page([fakes.alert(str(client_record.id))]))
    body = as_role("fee_earner").get("/api/v1/monitoring/alerts").json()
    assert body["total"] == 1
    assert body["items"][0]["kind"] == "ownership_change"
    assert as_role("fee_earner").get("/api/v1/monitoring/alerts?kind=nope").status_code == 422
    assert (
        as_role("fee_earner")
        .post("/api/v1/monitoring/alerts/a1/resolve", {"outcome": "resolved", "note": "Checked"}, format="json")
        .status_code
        == 403
    )


def test_review_scheduling(as_role, client_record, monkeypatch):
    seen = {}

    def schedule(org, cid, due, actor):
        seen["due"] = due
        return {"clientId": str(cid), "nextReviewOn": due.isoformat()}

    def complete(org, cid, actor, note=""):
        seen["note"] = note
        return {"clientId": str(cid)}

    monkeypatch.setattr(monitoring_api, "schedule_review", schedule)
    monkeypatch.setattr(monitoring_api, "complete_review", complete, raising=False)
    co = as_role("compliance_officer")
    past = co.post(f"/api/v1/clients/{client_record.id}/review", {"dueOn": "2001-01-01"}, format="json")
    assert past.status_code == 422
    assert (
        co.post(f"/api/v1/clients/{client_record.id}/review", {"dueOn": "2099-01-01"}, format="json").status_code == 200
    )
    assert str(seen["due"]) == "2099-01-01"
    done = co.post(
        f"/api/v1/clients/{client_record.id}/review",
        {"completed": True, "note": "Reviewed file, no change."},
        format="json",
    )
    assert done.status_code == 200
    assert seen["note"] == "Reviewed file, no change."
    short = co.post(f"/api/v1/clients/{client_record.id}/review", {"completed": True, "note": "ok"}, format="json")
    assert short.status_code == 422


def test_assistant_question_limits(as_role, monkeypatch):
    api = as_role("fee_earner")
    assert api.post("/api/v1/assistant/ask", {"question": "x" * 501}, format="json").status_code == 422
    assert (
        as_role("auditor").post("/api/v1/assistant/ask", {"question": "Who owns X?"}, format="json").status_code == 403
    )
    resp = api.post(
        "/api/v1/assistant/ask",
        {"question": "Who owns X?", "clientId": "55555555-5555-5555-5555-555555555555"},
        format="json",
    )
    assert resp.status_code == 404


def test_assistant_answer_carries_its_graph(as_role):
    """The answer includes the cited parties and links as one graphology payload (null when nothing was traced)."""
    body = (
        as_role("compliance_officer")
        .post("/api/v1/assistant/ask", {"question": "Who controls Nobody Pty Ltd?"}, format="json")
        .json()
    )
    assert "graph" in body and body["graph"] is None
    history = as_role("compliance_officer").get("/api/v1/assistant/history").json()
    assert history and "graph" in history[0]


def test_holds_are_listed_for_the_compliance_officer_only(as_role, client_record):
    co = as_role("compliance_officer")
    assert co.get(f"/api/v1/clients/{client_record.id}/holds").json() == {"active": False, "holds": []}
    assert (
        co.post(
            f"/api/v1/clients/{client_record.id}/holds", {"note": "Waiting on our review."}, format="json"
        ).status_code
        == 201
    )
    body = co.get(f"/api/v1/clients/{client_record.id}/holds").json()
    assert body["active"] and body["holds"][0]["reason"] == "manual" and body["holds"][0]["note"]
    assert as_role("fee_earner").get(f"/api/v1/clients/{client_record.id}/holds").status_code == 403
    assert co.post(
        f"/api/v1/clients/{client_record.id}/holds/release", {"note": "Review done."}, format="json"
    ).json() == {"released": 1}


def test_pinned_answers_list_and_unknown_answer(as_role, client_record):
    co = as_role("compliance_officer")
    assert co.get(f"/api/v1/clients/{client_record.id}/pins").json() == []
    resp = co.post(
        "/api/v1/assistant/answers/55555555-5555-5555-5555-555555555555/pin",
        {"clientId": str(client_record.id)},
        format="json",
    )
    assert resp.status_code == 404
