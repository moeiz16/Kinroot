"""Clients, parties, relationships, evidence, onboarding, submit, communications, exit (contract §1.6)."""

from __future__ import annotations

from datetime import date, timedelta

import pytest
from django.utils import timezone

from audit.models import AuditLog
from clients.models import Client, ClientHold, Communication, Consent, Party, Relationship, VerificationCheck
from clients.services import HOLD_MESSAGE, place_hold, rebuild_structure
from jobs import api as jobs_api
from jobs.models import Job
from tests.api.helpers import link, make_client_record, make_party

pytestmark = pytest.mark.django_db

PDF = b"%PDF-1.4\n% sample\n%%EOF\n"


def new_individual(api, **over):
    body = {
        "kind": "individual",
        "jurisdiction": "AU",
        "services": ["conveyancing"],
        "channel": "face_to_face",
        "person": {
            "givenNames": "Linh",
            "familyName": "Nguyen",
            "birthDate": "1990-10-05",
            "nationality": "AU",
            "address": {
                "line1": "7 Railway Pde",
                "locality": "Burwood",
                "state": "NSW",
                "postcode": "2134",
                "country": "AU",
            },
        },
    }
    body.update(over)
    return api.post("/api/v1/clients", body, format="json")


def test_create_individual_client(as_role):
    resp = new_individual(as_role("fee_earner"))
    assert resp.status_code == 201, resp.content
    body = resp.json()
    assert body["name"] == "Linh Nguyen"
    assert body["status"] == "onboarding"
    assert body["assignedTo"]["fullName"].startswith("Fee Earner")
    party = Party.objects.get(id=body["partyId"])
    assert party.address["postcode"] == "2134"
    assert AuditLog.objects.filter(action="client.created").count() == 1


def test_create_company_with_identifiers(as_role):
    resp = as_role("partner").post(
        "/api/v1/clients",
        {
            "kind": "company",
            "name": "Bellmere Holdings Pty Ltd",
            "jurisdiction": "AU",
            "services": ["company_formation"],
            "channel": "remote",
            "identifiers": {"acn": "609 112 584", "ukCompanyNumber": "12847719"},
        },
        format="json",
    )
    assert resp.status_code == 201
    party = Party.objects.get(id=resp.json()["partyId"])
    assert party.identifiers == {"acn": "609 112 584", "ukCompanyNumber": "12847719"}


def test_create_validation(as_role):
    api = as_role("fee_earner")
    resp = new_individual(
        api,
        person={
            "givenNames": "A",
            "familyName": "B",
            "birthDate": "2999-01-01",
            "address": {"country": "AU", "postcode": "20"},
        },
    )
    assert resp.status_code == 422
    fields = {e["field"] for e in resp.json()["errors"]}
    assert "person.address.postcode" in fields
    bad = api.post(
        "/api/v1/clients", {"kind": "company", "jurisdiction": "AU", "services": [], "channel": "x"}, format="json"
    )
    assert {e["field"] for e in bad.json()["errors"]} >= {"services", "channel"}


def test_onboard_permission(as_role):
    assert new_individual(as_role("owner")).status_code == 403
    assert new_individual(as_role("auditor")).status_code == 403


def test_list_filters_and_paging(as_role, firm):
    for i in range(3):
        make_client_record(firm, f"Alpha {i} Pty Ltd", rating="low")
    make_client_record(
        firm,
        "Zeta Holdings Pty Ltd",
        rating="high",
        status="active",
        next_review_on=timezone.localdate() + timedelta(days=5),
    )
    api = as_role("auditor")
    page = api.get("/api/v1/clients?pageSize=2&page=2").json()
    assert page["total"] == 4
    assert page["totalPages"] == 2
    assert len(page["items"]) == 2
    assert [c["name"] for c in api.get("/api/v1/clients?rating=high").json()["items"]] == ["Zeta Holdings Pty Ltd"]
    assert api.get("/api/v1/clients?q=alpha").json()["total"] == 3
    assert api.get("/api/v1/clients?reviewDue=true").json()["total"] == 1
    mine = as_role("fee_earner").get("/api/v1/clients?assignedTo=me").json()["total"]
    assert mine == 4


def test_detail_patch_and_validation(as_role, client_record, firm):
    api = as_role("fee_earner")
    body = api.get(f"/api/v1/clients/{client_record.id}").json()
    assert set(body) >= {"structure", "flags", "ratingSource", "eddRequired", "nextReviewOn", "sample"}
    resp = api.patch(
        f"/api/v1/clients/{client_record.id}",
        {"matterReference": "HL-9", "assignedToId": str(firm["users"]["partner"].id)},
        format="json",
    )
    assert resp.status_code == 200
    assert resp.json()["matterReference"] == "HL-9"
    assert resp.json()["assignedTo"]["id"] == str(firm["users"]["partner"].id)
    stranger = api.patch(
        f"/api/v1/clients/{client_record.id}", {"assignedToId": "00000000-0000-0000-0000-000000000001"}, format="json"
    )
    assert stranger.status_code == 422


def test_add_party_and_party_detail(as_role, client_record):
    api = as_role("fee_earner")
    resp = api.post(
        f"/api/v1/clients/{client_record.id}/parties",
        {"kind": "person", "name": "Ava Calder", "birthDate": "1971-04-12", "nationality": "AU"},
        format="json",
    )
    assert resp.status_code == 201
    pid = resp.json()["id"]
    detail = api.get(f"/api/v1/parties/{pid}").json()
    assert detail["clients"] == [{"id": str(client_record.id), "name": client_record.name}]
    assert detail["sourceRecords"] == []
    parties = api.get(f"/api/v1/clients/{client_record.id}/parties").json()
    assert {p["id"] for p in parties} >= {pid, str(client_record.party_id)}
    patched = api.patch(f"/api/v1/parties/{pid}", {"name": "Ava M. Calder"}, format="json")
    assert patched.json()["name"] == "Ava M. Calder"


def test_relationship_validation(as_role, client_record, firm):
    api = as_role("fee_earner")
    owner = make_party(firm["org"], "Kestrel Ventures Ltd", "company", jurisdiction="VG")
    base = {
        "fromPartyId": str(owner.id),
        "toPartyId": str(client_record.party_id),
        "kind": "ownership",
        "validFrom": "2020-01-01",
    }
    assert api.post("/api/v1/relationships", {**base, "pct": 0}, format="json").status_code == 422
    assert api.post("/api/v1/relationships", {**base, "pct": 101}, format="json").status_code == 422
    self_own = api.post(
        "/api/v1/relationships", {**base, "fromPartyId": str(client_record.party_id), "pct": 10}, format="json"
    )
    assert self_own.status_code == 422
    ok = api.post("/api/v1/relationships", {**base, "pct": 80}, format="json")
    assert ok.status_code == 201
    assert ok.json()["interest"] == "shares"
    other = make_party(firm["org"], "Ben Okafor")
    over = api.post("/api/v1/relationships", {**base, "fromPartyId": str(other.id), "pct": 30}, format="json")
    assert over.status_code == 422
    assert over.json()["code"] == "over_allocated"
    control = api.post(
        "/api/v1/relationships", {**base, "fromPartyId": str(other.id), "kind": "control"}, format="json"
    )
    assert control.status_code == 422
    director = api.post(
        "/api/v1/relationships",
        {**base, "fromPartyId": str(other.id), "kind": "control", "role": "director"},
        format="json",
    )
    assert director.status_code == 201
    assert director.json()["pct"] is None


def test_non_overlapping_ownership_is_allowed(as_role, client_record, firm):
    api = as_role("fee_earner")
    a = make_party(firm["org"], "Old Owner")
    b = make_party(firm["org"], "New Owner")
    link(firm["org"], a, client_record.party, pct=100, since=date(2015, 1, 1), valid_to=date(2019, 12, 31))
    resp = api.post(
        "/api/v1/relationships",
        {
            "fromPartyId": str(b.id),
            "toPartyId": str(client_record.party_id),
            "kind": "ownership",
            "pct": 100,
            "validFrom": "2020-01-01",
        },
        format="json",
    )
    assert resp.status_code == 201


def test_end_and_delete_relationship(as_role, client_record, firm):
    api = as_role("partner")
    rel = link(firm["org"], make_party(firm["org"], "Phil Burke"), client_record.party, "control", role="director")
    ended = api.patch(f"/api/v1/relationships/{rel.id}", {"validTo": "2025-09-30"}, format="json")
    assert ended.json()["validTo"] == "2025-09-30"
    assert AuditLog.objects.filter(action="relationship.ended").exists()
    assert api.delete(f"/api/v1/relationships/{rel.id}", {}, format="json").status_code == 422
    assert (
        api.delete(
            f"/api/v1/relationships/{rel.id}", {"reason": "Entered against the wrong company"}, format="json"
        ).status_code
        == 204
    )
    assert not Relationship.objects.filter(id=rel.id).exists()


def test_graph_write_permission(as_role, client_record):
    resp = as_role("auditor").post(
        f"/api/v1/clients/{client_record.id}/parties", {"kind": "person", "name": "X"}, format="json"
    )
    assert resp.status_code == 403


def test_document_upload_and_download(as_role, client_record):
    api = as_role("fee_earner")
    from django.core.files.uploadedfile import SimpleUploadedFile

    upload = SimpleUploadedFile("passport.pdf", PDF, content_type="application/pdf")
    resp = api.post(
        f"/api/v1/clients/{client_record.id}/documents",
        {"file": upload, "partyId": str(client_record.party_id), "docType": "company_extract"},
        format="multipart",
    )
    assert resp.status_code == 201, resp.content
    doc = resp.json()
    assert doc["sizeBytes"] == len(PDF)
    assert len(doc["sha256"]) == 64
    file_resp = api.get(f"/api/v1/documents/{doc['id']}/file")
    assert file_resp.status_code == 200
    assert file_resp["Content-Disposition"].startswith("attachment")
    assert b"".join(file_resp.streaming_content) == PDF
    assert [d["id"] for d in api.get(f"/api/v1/clients/{client_record.id}/documents").json()] == [doc["id"]]


def test_upload_rejects_wrong_type_and_size(as_role, client_record, settings):
    from django.core.files.uploadedfile import SimpleUploadedFile

    api = as_role("fee_earner")
    exe = SimpleUploadedFile("evil.pdf", b"MZ\x90\x00 not a pdf", content_type="application/pdf")
    resp = api.post(
        f"/api/v1/clients/{client_record.id}/documents",
        {"file": exe, "partyId": str(client_record.party_id), "docType": "other"},
        format="multipart",
    )
    assert resp.status_code == 415
    settings.MAX_UPLOAD_MB = 0
    big = SimpleUploadedFile("big.pdf", PDF, content_type="application/pdf")
    resp = api.post(
        f"/api/v1/clients/{client_record.id}/documents",
        {"file": big, "partyId": str(client_record.party_id), "docType": "other"},
        format="multipart",
    )
    assert resp.status_code == 413


def test_verification_and_consent(as_role, firm):
    client = make_client_record(firm, "Linh Nguyen", kind="individual")
    party = client.party
    party.birth_date = date(1990, 10, 5)
    party.address = {"line1": "7 Railway Pde", "country": "AU"}
    party.save()
    api = as_role("fee_earner")
    no_consent = api.post(
        f"/api/v1/clients/{client.id}/verification", {"partyId": str(party.id), "method": "electronic"}, format="json"
    )
    assert no_consent.status_code == 422
    consent = api.post(
        f"/api/v1/clients/{client.id}/consent",
        {
            "partyId": str(party.id),
            "purpose": "electronic_check",
            "givenOn": timezone.localdate().isoformat(),
            "method": "Online form",
        },
        format="json",
    )
    assert consent.status_code == 201
    check = api.post(
        f"/api/v1/clients/{client.id}/verification", {"partyId": str(party.id), "method": "electronic"}, format="json"
    )
    assert check.status_code == 201
    body = check.json()
    assert body["result"] == "verified"
    assert body["reference"].startswith("MOCK-DVS-")
    assert body["demo"] is True
    assert len(api.get(f"/api/v1/clients/{client.id}/verification").json()) == 1
    assert len(api.get(f"/api/v1/clients/{client.id}/consent").json()) == 1


def test_document_verification_needs_own_documents(as_role, client_record):
    resp = as_role("fee_earner").post(
        f"/api/v1/clients/{client_record.id}/verification",
        {
            "partyId": str(client_record.party_id),
            "method": "document",
            "documentIds": ["7d8c0d64-0c1b-4c1e-9d55-1f2b3c4d5e6f"],
        },
        format="json",
    )
    assert resp.status_code == 422


def test_onboarding_checklist_and_submit(as_role, firm, no_domain):
    client = make_client_record(firm, "Riya Patel", kind="individual")
    api = as_role("fee_earner")
    checklist = api.get(f"/api/v1/clients/{client.id}/onboarding").json()
    keys = [i["key"] for i in checklist["items"]]
    assert keys[:2] == [f"identity_{client.party_id}", f"consent_{client.party_id}"]
    assert checklist["canSubmit"] is False
    missing = api.post(f"/api/v1/clients/{client.id}/submit")
    assert missing.status_code == 422
    assert missing.json()["code"] == "invalid_transition"
    assert {e["field"] for e in missing.json()["errors"]} == {
        f"identity_{client.party_id}",
        f"consent_{client.party_id}",
    }
    Consent.objects.create(
        org=firm["org"],
        client=client,
        party=client.party,
        purpose="identity_verification",
        given_on=timezone.localdate(),
        method="Signed",
    )
    VerificationCheck.objects.create(
        org=firm["org"],
        client=client,
        party=client.party,
        method="document",
        result="verified",
        reference="MOCK-DVS-1",
        checked_at=timezone.now(),
    )
    assert api.get(f"/api/v1/clients/{client.id}/onboarding").json()["canSubmit"] is True
    jobs_api.register("screening.client")(lambda p: None)
    jobs_api.register("risk.assess_client")(lambda p: None)
    try:
        resp = api.post(f"/api/v1/clients/{client.id}/submit")
    finally:
        jobs_api._REGISTRY.pop("screening.client", None)
        jobs_api._REGISTRY.pop("risk.assess_client", None)
    assert resp.status_code == 202
    assert [j["kind"] for j in resp.json()["jobs"]] == ["screening.client", "risk.assess_client"]
    assert Client.objects.get(id=client.id).submitted_at is not None
    assert api.post(f"/api/v1/clients/{client.id}/submit").status_code == 422


def test_entity_checklist_fallback_finds_ubos(as_role, firm, no_domain):
    client = make_client_record(firm, "Greenfield Estates Pty Ltd")
    ben = make_party(firm["org"], "Benjamin Okafor")
    lucy = make_party(firm["org"], "Lucy Okafor")
    link(firm["org"], ben, client.party, pct=70)
    link(firm["org"], lucy, client.party, pct=20)
    rebuild_structure(firm["org"].id)
    items = as_role("fee_earner").get(f"/api/v1/clients/{client.id}/onboarding").json()["items"]
    keys = {i["key"] for i in items}
    assert f"identity_{ben.id}" in keys
    assert f"identity_{lucy.id}" not in keys
    assert next(i for i in items if i["key"] == "structure_confirmed")["done"] is True


def test_communications_sent_and_held(as_role, client_record, firm):
    api = as_role("fee_earner")
    sent = api.post(
        f"/api/v1/clients/{client_record.id}/communications",
        {"kind": "information_request", "message": "Please send a certified passport copy."},
        format="json",
    )
    assert sent.status_code == 202
    place_hold(client_record, "manual", note="Wait")
    held = api.post(
        f"/api/v1/clients/{client_record.id}/communications",
        {"kind": "information_request", "message": "Another request"},
        format="json",
    )
    assert held.status_code == 409
    assert held.json()["code"] == "action_held"
    assert held.json()["detail"] == HOLD_MESSAGE
    assert Communication.objects.filter(status="held").count() == 1


def test_exit_and_exit_held(as_role, firm):
    api = as_role("fee_earner")
    held_client = make_client_record(firm, "Held Pty Ltd", status="active")
    place_hold(held_client, "manual")
    resp = api.post(f"/api/v1/clients/{held_client.id}/exit", {"reason": "Matter complete"}, format="json")
    assert resp.status_code == 409
    assert resp.json()["detail"] == HOLD_MESSAGE
    free = make_client_record(firm, "Free Pty Ltd", status="active")
    resp = api.post(f"/api/v1/clients/{free.id}/exit", {"reason": "Matter complete"}, format="json")
    assert resp.status_code == 200
    assert resp.json()["status"] == "exited"
    assert resp.json()["relationshipEndedOn"] == timezone.localdate().isoformat()
    assert api.post(f"/api/v1/clients/{free.id}/exit", {"reason": "again"}, format="json").status_code == 409


def test_blocked_client_is_locked(as_role, firm):
    client = make_client_record(firm, "Aurelian Shipping Pty Ltd", status="blocked")
    api = as_role("fee_earner")
    resp = api.patch(f"/api/v1/clients/{client.id}", {"matterReference": "X"}, format="json")
    assert resp.status_code == 423
    assert resp.json()["code"] == "client_blocked"
    assert api.post(f"/api/v1/clients/{client.id}/exit", {"reason": "x"}, format="json").status_code == 423
    assert api.get(f"/api/v1/clients/{client.id}").status_code == 200


def test_holds_are_compliance_only(as_role, client_record):
    assert (
        as_role("partner").post(f"/api/v1/clients/{client_record.id}/holds", {"note": "x"}, format="json").status_code
        == 403
    )
    co = as_role("compliance_officer")
    assert (
        co.post(f"/api/v1/clients/{client_record.id}/holds", {"note": "Pending review"}, format="json").status_code
        == 201
    )
    assert ClientHold.objects.filter(released_at__isnull=True).count() == 1
    resp = co.post(f"/api/v1/clients/{client_record.id}/holds/release", {"note": "Cleared"}, format="json")
    assert resp.json() == {"released": 1}


def test_registry_search_and_import_endpoint(as_role, firm):
    api = as_role("fee_earner")
    hits = api.get("/api/v1/registry/search?source=au_abr&q=ironstone").json()
    assert hits[0]["name"] == "Ironstone Freight Pty Ltd"
    assert hits[0]["sample"] is True
    assert api.get("/api/v1/registry/search?source=xx&q=a").status_code == 422
    client = make_client_record(firm, "Ironstone Freight Pty Ltd")
    resp = api.post(
        f"/api/v1/clients/{client.id}/registry-import",
        {"source": "au_abr", "reference": hits[0]["reference"]},
        format="json",
    )
    assert resp.status_code == 201
    assert resp.json()["relationshipsCreated"] == 3
    missing = api.post(
        f"/api/v1/clients/{client.id}/registry-import", {"source": "au_abr", "reference": "000"}, format="json"
    )
    assert missing.status_code == 404
    assert Job.objects.filter(kind="resolution.find_candidates").count() <= 1
