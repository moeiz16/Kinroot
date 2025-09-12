"""Organisation, members, invitations, settings, retention and training (contract §1.4)."""

from __future__ import annotations

from datetime import timedelta

import pytest
from django.utils import timezone

from accounts.models import Invitation, Membership, TrainingRecord
from jobs.models import Job
from tests.api.helpers import csrf_client, make_client_record, signed_in

pytestmark = pytest.mark.django_db


def test_org_get_and_patch_by_admin(as_role):
    owner = as_role("owner")
    assert owner.get("/api/v1/org").json()["dataResidency"] == "AU"
    resp = owner.patch("/api/v1/org", {"name": "Harbourline Legal Pty Ltd", "sector": "conveyancing"}, format="json")
    assert resp.status_code == 200
    assert resp.json()["name"] == "Harbourline Legal Pty Ltd"


def test_org_patch_forbidden_for_compliance_officer(as_role):
    resp = as_role("compliance_officer").patch("/api/v1/org", {"name": "X"}, format="json")
    assert resp.status_code == 403
    assert resp.json()["code"] == "forbidden"


def test_members_list_shape(as_role, firm):
    TrainingRecord.objects.create(
        org=firm["org"],
        user=firm["users"]["fee_earner"],
        course="CDD",
        completed_on=timezone.localdate(),
        due_on=timezone.localdate() + timedelta(days=365),
    )
    members = as_role("auditor").get("/api/v1/org/members").json()
    assert len(members) == 5
    fee = next(m for m in members if m["role"] == "fee_earner")
    assert fee["roleLabel"] == "Fee earner"
    assert fee["status"] == "active"
    assert fee["trainingDueOn"]


def test_change_role_and_last_owner_guard(as_role, firm):
    owner = as_role("owner")
    m = Membership.objects.get(org=firm["org"], user=firm["users"]["fee_earner"])
    assert owner.patch(f"/api/v1/org/members/{m.id}", {"role": "partner"}, format="json").json()["role"] == "partner"
    own = Membership.objects.get(org=firm["org"], user=firm["users"]["owner"])
    resp = owner.patch(f"/api/v1/org/members/{own.id}", {"role": "auditor"}, format="json")
    assert resp.status_code == 409
    assert owner.delete(f"/api/v1/org/members/{own.id}").status_code == 409


def test_remove_member(as_role, firm):
    m = Membership.objects.get(org=firm["org"], user=firm["users"]["auditor"])
    assert as_role("owner").delete(f"/api/v1/org/members/{m.id}").status_code == 204
    assert not Membership.objects.filter(id=m.id).exists()


def test_members_manage_is_owner_only(as_role, firm):
    m = Membership.objects.get(org=firm["org"], user=firm["users"]["auditor"])
    assert as_role("compliance_officer").delete(f"/api/v1/org/members/{m.id}").status_code == 403


def test_invitation_flow_new_user(as_role, firm):
    owner = as_role("owner")
    resp = owner.post(
        "/api/v1/org/invitations", {"email": "New.Person@harbourline.test", "role": "fee_earner"}, format="json"
    )
    assert resp.status_code == 201
    url = resp.json()["inviteUrl"]
    token = url.rsplit("/", 1)[1]
    inv = Invitation.objects.get()
    assert token not in inv.token_hash
    public = csrf_client()
    info = public.get(f"/api/v1/invitations/{token}").json()
    assert info == {
        "orgName": "Harbourline Legal",
        "email": "new.person@harbourline.test",
        "role": "fee_earner",
        "roleLabel": "Fee earner",
        "expiresAt": info["expiresAt"],
    }
    accepted = public.post(
        f"/api/v1/invitations/{token}/accept",
        {"fullName": "New Person", "password": "Quiet-River-Stones-42"},
        format="json",
    )
    assert accepted.status_code == 200, accepted.content
    assert accepted.json()["membership"]["role"] == "fee_earner"
    assert public.get(f"/api/v1/invitations/{token}").status_code == 404


def test_invitation_accept_when_signed_in(as_role, firm, other_firm):
    owner = as_role("owner")
    invitee = other_firm["users"]["partner"]
    token = (
        owner.post("/api/v1/org/invitations", {"email": invitee.email, "role": "partner"}, format="json")
        .json()["inviteUrl"]
        .rsplit("/", 1)[1]
    )
    api = signed_in(invitee)
    resp = api.post(f"/api/v1/invitations/{token}/accept", {}, format="json")
    assert resp.status_code == 200
    assert resp.json()["activeOrg"]["name"] == "Harbourline Legal"
    assert len(resp.json()["orgs"]) == 2


def test_invitation_for_different_signed_in_email(as_role, firm, other_firm):
    token = (
        as_role("owner")
        .post("/api/v1/org/invitations", {"email": "someone@else.test", "role": "auditor"}, format="json")
        .json()["inviteUrl"]
        .rsplit("/", 1)[1]
    )
    resp = signed_in(other_firm["users"]["owner"]).post(f"/api/v1/invitations/{token}/accept", {}, format="json")
    assert resp.status_code == 409


def test_expired_and_revoked_invitations(as_role):
    owner = as_role("owner")
    token = (
        owner.post("/api/v1/org/invitations", {"email": "late@x.test", "role": "auditor"}, format="json")
        .json()["inviteUrl"]
        .rsplit("/", 1)[1]
    )
    Invitation.objects.update(expires_at=timezone.now() - timedelta(minutes=1))
    assert csrf_client().get(f"/api/v1/invitations/{token}").status_code == 410
    inv = Invitation.objects.get()
    assert owner.delete(f"/api/v1/org/invitations/{inv.id}").status_code == 204
    assert csrf_client().get(f"/api/v1/invitations/{token}").status_code == 404
    assert owner.get("/api/v1/org/invitations").json() == []


def test_invite_existing_member_conflicts(as_role, firm):
    resp = as_role("owner").post(
        "/api/v1/org/invitations", {"email": firm["users"]["auditor"].email, "role": "auditor"}, format="json"
    )
    assert resp.status_code == 409


def test_settings_defaults(as_role):
    body = as_role("fee_earner").get("/api/v1/settings").json()
    assert body["retention"] == {"years": 7, "trigger": "relationship_end", "legalHoldClientIds": []}
    assert body["reviews"] == {"highMonths": 12, "mediumMonths": 24, "lowMonths": 36}
    assert body["ubo"]["thresholdPct"] == 25
    assert body["notifications"]["criticalAlerts"] == "immediate"


def test_settings_retention_minimum_by_country(as_role):
    co = as_role("compliance_officer")
    resp = co.patch("/api/v1/settings", {"retention": {"years": 5}}, format="json")
    assert resp.status_code == 422
    assert resp.json()["errors"][0]["field"] == "retention.years"
    ok = co.patch("/api/v1/settings", {"retention": {"years": 10}}, format="json")
    assert ok.status_code == 200
    assert ok.json()["retention"]["years"] == 10


def test_uk_firm_may_keep_five_years(other_firm):
    api = signed_in(other_firm["users"]["owner"])
    assert api.patch("/api/v1/settings", {"retention": {"years": 5}}, format="json").status_code == 200


def test_settings_section_permissions(as_role):
    assert (
        as_role("fee_earner").patch("/api/v1/settings", {"reviews": {"highMonths": 6}}, format="json").status_code
        == 403
    )
    assert as_role("owner").patch("/api/v1/settings", {"reviews": {"highMonths": 6}}, format="json").status_code == 200
    resp = as_role("compliance_officer").patch(
        "/api/v1/settings", {"notifications": {"reviewReminderDays": 14}}, format="json"
    )
    assert resp.json()["notifications"]["reviewReminderDays"] == 14
    assert as_role("owner").patch("/api/v1/settings", {"bogus": {}}, format="json").status_code == 422


def test_legal_hold_must_name_own_clients(as_role, firm, other_firm):
    theirs = make_client_record(other_firm, "Penrose Bakeries Ltd")
    mine = make_client_record(firm, "Coastal Conveyancing Co", kind="partnership")
    co = as_role("compliance_officer")
    bad = co.patch("/api/v1/settings", {"retention": {"legalHoldClientIds": [str(theirs.id)]}}, format="json")
    assert bad.status_code == 422
    good = co.patch("/api/v1/settings", {"retention": {"legalHoldClientIds": [str(mine.id)]}}, format="json")
    assert good.json()["retention"]["legalHoldClientIds"] == [str(mine.id)]


def test_retention_preview_and_run(as_role, firm):
    make_client_record(
        firm,
        "Coastal Conveyancing Co",
        kind="partnership",
        status="exited",
        relationship_ended_on=timezone.localdate() - timedelta(days=730),
    )
    co = as_role("compliance_officer")
    preview = co.get("/api/v1/settings/retention/preview").json()
    assert preview["dueCount"] == 0
    assert preview["items"][0]["recordType"] == "client"
    run = co.post("/api/v1/settings/retention/run", {}, format="json")
    assert run.status_code == 202
    assert run.json()["kind"] == "retention.run"
    assert Job.objects.get(kind="retention.run").payload["dryRun"] is True
    assert as_role("fee_earner").get("/api/v1/settings/retention/preview").status_code == 403


def test_training_register(as_role, firm):
    owner = as_role("owner")
    today = timezone.localdate()
    resp = owner.post(
        "/api/v1/training",
        {
            "userId": str(firm["users"]["fee_earner"].id),
            "course": "CDD basics",
            "completedOn": (today - timedelta(days=360)).isoformat(),
        },
        format="json",
    )
    assert resp.status_code == 201
    assert resp.json()["status"] == "due_soon"
    owner.post(
        "/api/v1/training",
        {
            "userId": str(firm["users"]["partner"].id),
            "course": "PEPs",
            "completedOn": (today - timedelta(days=400)).isoformat(),
        },
        format="json",
    )
    rows = as_role("auditor").get("/api/v1/training").json()
    assert {r["status"] for r in rows} == {"due_soon", "overdue"}
    assert as_role("fee_earner").post("/api/v1/training", {}, format="json").status_code == 403
    future = owner.post(
        "/api/v1/training",
        {
            "userId": str(firm["users"]["partner"].id),
            "course": "X",
            "completedOn": (today + timedelta(days=3)).isoformat(),
        },
        format="json",
    )
    assert future.status_code == 422
