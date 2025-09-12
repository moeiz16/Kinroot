"""Tenant isolation: another firm's ids behave exactly like unknown ids, and lists never cross firms."""

from __future__ import annotations

import uuid

import pytest
from django.utils import timezone

from accounts.models import Invitation, Membership
from audit import api as audit
from cases.models import Case
from clients.models import Document
from jobs import api as jobs_api
from kinroot.contracts import Actor
from tests.api.helpers import link, make_client_record, make_party, signed_in

pytestmark = pytest.mark.django_db


@pytest.fixture
def theirs(other_firm):
    org = other_firm["org"]
    client = make_client_record(other_firm, "Penrose Bakeries Ltd")
    owner = make_party(org, "Amelia Penrose")
    rel = link(org, owner, client.party, pct=100)
    doc = Document.objects.create(
        org=org,
        client=client,
        party=client.party,
        doc_type="other",
        file="x.pdf",
        file_name="x.pdf",
        content_type="application/pdf",
        sha256="0" * 64,
        size=1,
    )
    job = jobs_api.enqueue("retention.run", {}, org_id=org.id)
    case = Case.objects.create(
        org=org,
        client=client,
        title="T",
        grounds="G" * 20,
        opened_by=other_firm["users"]["compliance_officer"],
        opened_at=timezone.now(),
        deadline_on=timezone.localdate(),
    )
    inv = Invitation.objects.create(
        org=org, email="x@y.test", role="auditor", token_hash="h" * 64, expires_at=timezone.now()
    )
    member = Membership.objects.get(org=org, user=other_firm["users"]["auditor"])
    return {
        "client": client,
        "party": owner,
        "rel": rel,
        "doc": doc,
        "job": job,
        "case": case,
        "inv": inv,
        "member": member,
    }


def _assert_404_like_unknown(api, path_template, real_id, method="get", body=None):
    fake = uuid.uuid4()
    call = getattr(api, method)
    kwargs = {"format": "json"} if body is not None else {}
    args = (body,) if body is not None else ()
    real = call(path_template.format(real_id), *args, **kwargs)
    unknown = call(path_template.format(fake), *args, **kwargs)
    assert real.status_code == unknown.status_code == 404, (path_template, real.status_code, unknown.status_code)
    a, b = real.json(), unknown.json()
    a.pop("requestId"), b.pop("requestId")
    assert a == b


GET_PATHS = [
    ("client", "/api/v1/clients/{}"),
    ("client", "/api/v1/clients/{}/parties"),
    ("client", "/api/v1/clients/{}/onboarding"),
    ("client", "/api/v1/clients/{}/documents"),
    ("client", "/api/v1/clients/{}/edd"),
    ("client", "/api/v1/clients/{}/graph"),
    ("client", "/api/v1/clients/{}/ubo"),
    ("client", "/api/v1/clients/{}/risk"),
    ("party", "/api/v1/parties/{}"),
    ("party", "/api/v1/parties/{}/graph"),
    ("party", "/api/v1/parties/{}/thread"),
    ("doc", "/api/v1/documents/{}/file"),
    ("job", "/api/v1/jobs/{}"),
    ("case", "/api/v1/cases/{}"),
    ("case", "/api/v1/cases/{}/smr"),
    ("case", "/api/v1/cases/{}/timeline"),
]


@pytest.mark.parametrize(("kind", "path"), GET_PATHS)
def test_other_firm_ids_are_404_for_reads(firm, theirs, kind, path):
    api = signed_in(firm["users"]["compliance_officer"])
    target = theirs[kind]
    _assert_404_like_unknown(api, path, getattr(target, "id", target))


def test_other_firm_ids_are_404_for_writes(firm, theirs):
    api = signed_in(firm["users"]["owner"])
    _assert_404_like_unknown(api, "/api/v1/org/members/{}", theirs["member"].id, "patch", {"role": "auditor"})
    _assert_404_like_unknown(api, "/api/v1/org/invitations/{}", theirs["inv"].id, "delete")
    co = signed_in(firm["users"]["compliance_officer"])
    _assert_404_like_unknown(co, "/api/v1/clients/{}", theirs["client"].id, "patch", {"matterReference": "X"})
    _assert_404_like_unknown(co, "/api/v1/relationships/{}", theirs["rel"].id, "patch", {"pct": 50})
    _assert_404_like_unknown(co, "/api/v1/cases/{}", theirs["case"].id, "patch", {"title": "Mine now"})


def test_relationship_cannot_link_parties_across_firms(firm, theirs):
    mine = make_client_record(firm, "Bellmere Holdings Pty Ltd")
    resp = signed_in(firm["users"]["fee_earner"]).post(
        "/api/v1/relationships",
        {
            "fromPartyId": str(theirs["party"].id),
            "toPartyId": str(mine.party_id),
            "kind": "ownership",
            "pct": 50,
            "validFrom": "2020-01-01",
        },
        format="json",
    )
    assert resp.status_code == 422


def test_lists_are_scoped_to_the_active_firm(firm, other_firm, theirs):
    make_client_record(firm, "Bellmere Holdings Pty Ltd")
    audit.record(Actor(org_id=other_firm["org"].id, user_id=None), "client.created", resource_type="client")
    api = signed_in(firm["users"]["compliance_officer"])
    assert [c["name"] for c in api.get("/api/v1/clients").json()["items"]] == ["Bellmere Holdings Pty Ltd"]
    assert api.get("/api/v1/cases").json()["total"] == 0
    assert len(api.get("/api/v1/org/members").json()) == 5
    rows = api.get("/api/v1/audit").json()["items"]
    assert rows
    assert all(r["actorName"] != "System" for r in rows)
    verify = api.get("/api/v1/audit/verify").json()
    assert verify["valid"] is True
    assert verify["checked"] == len(rows)


def test_settings_and_org_are_per_firm(firm, other_firm):
    mine = signed_in(firm["users"]["owner"])
    mine.patch("/api/v1/settings", {"reviews": {"highMonths": 6}}, format="json")
    theirs_api = signed_in(other_firm["users"]["owner"])
    assert theirs_api.get("/api/v1/settings").json()["reviews"]["highMonths"] == 12
    assert theirs_api.get("/api/v1/org").json()["name"] == "Northgate Accountants"


def test_switching_firm_changes_scope(firm, other_firm, theirs):
    user = firm["users"]["compliance_officer"]
    Membership.objects.create(org=other_firm["org"], user=user, role="auditor")
    api = signed_in(user)
    assert api.get(f"/api/v1/clients/{theirs['client'].id}").status_code == 404
    api.post("/api/v1/auth/switch-org", {"orgId": str(other_firm["org"].id)}, format="json")
    assert api.get(f"/api/v1/clients/{theirs['client'].id}").status_code == 200
    assert api.get(f"/api/v1/cases/{theirs['case'].id}").status_code == 404  # auditor role: no case access


def test_events_are_scoped_to_firm(firm, other_firm):
    from api.sse import deliverable

    jobs_api.publish_event(other_firm["org"].id, "graph.synced", {"graphVersion": 3})
    jobs_api.publish_event(firm["org"].id, "graph.synced", {"graphVersion": 4})
    user = firm["users"]["compliance_officer"]
    events = deliverable(firm["org"].id, user.id, frozenset({"graph:read"}), 0)
    assert [e.data["graphVersion"] for e in events] == [4]
