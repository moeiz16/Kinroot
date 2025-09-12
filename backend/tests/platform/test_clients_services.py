"""System of record: structure membership, merge/split, client cache updates, registry, retention."""

from __future__ import annotations

from datetime import date, timedelta

import pytest
from django.utils import timezone

from audit.models import AuditLog
from clients import api as clients_api
from clients import registry, retention, services
from clients.models import Client, ClientParty, Document, EddCase, Party, Relationship
from kinroot.contracts import Actor, NotFound
from tests.api.helpers import link, make_client_record, make_party

pytestmark = pytest.mark.django_db


def actor(firm):
    u = firm["users"]["compliance_officer"]
    return Actor(org_id=firm["org"].id, user_id=u.id, name=u.full_name)


@pytest.fixture
def layered(firm):
    org = firm["org"]
    client = make_client_record(firm, "Harbour Quay Developments Pty Ltd")
    hold = make_party(org, "Kestrel Ventures Ltd", "company", jurisdiction="VG")
    mid = make_party(org, "Bellmere Holdings Pty Ltd", "company", jurisdiction="AU")
    ava = make_party(org, "Ava Calder", birth_date=date(1971, 4, 12))
    link(org, hold, client.party, pct=100)
    link(org, mid, hold, pct=80)
    link(org, ava, mid, pct=62)
    services.rebuild_structure(org.id)
    return {"client": client, "hold": hold, "mid": mid, "ava": ava}


def test_normalize_name_strips_suffixes_and_accents():
    assert services.normalize_name("Amélie Delacroix") == "amelie delacroix"
    assert services.normalize_name("Bellmere Holdings Pty Ltd") == "bellmere"
    assert services.normalize_name("Ferris & Wu Partners") == "ferris and wu partners"


def test_format_address_tolerates_missing_parts():
    assert (
        services.format_address(
            {"line1": "1 Bligh St", "locality": "Sydney", "state": "NSW", "postcode": "2000", "country": "AU"}
        )
        == "1 Bligh St, Sydney, NSW 2000, AU"
    )
    assert services.format_address({}) is None


def test_structure_levels_follow_ownership_upstream(layered):
    levels = dict(ClientParty.objects.filter(client=layered["client"]).values_list("party_id", "level"))
    assert levels[layered["client"].party_id] == 0
    assert levels[layered["hold"].id] == 1
    assert levels[layered["mid"].id] == 2
    assert levels[layered["ava"].id] == 3


def test_new_relationship_updates_structure_via_signal(firm, layered):
    ben = make_party(firm["org"], "Ben Okafor")
    link(firm["org"], ben, layered["mid"], pct=38)
    assert ClientParty.objects.filter(client=layered["client"], party=ben, level=3).exists()


def test_structure_summary_and_flags(layered):
    summary = services.structure_summary(layered["client"])
    assert summary == {"parties": 4, "layers": 3, "ubos": 0}
    assert "offshore" in services.structure_flags(layered["client"])


def test_cycle_flag(firm):
    org = firm["org"]
    client = make_client_record(firm, "Tasman Ridge Pty Ltd")
    a = make_party(org, "Orchard Lane Investments Pty Ltd", "company")
    b = make_party(org, "Westerly Capital Ltd", "company", jurisdiction="NZ")
    link(org, client.party, a, pct=60)
    link(org, a, b, pct=70)
    link(org, b, client.party, pct=50)
    services.rebuild_structure(org.id)
    assert "circular" in services.structure_flags(client)


def test_party_records_exclude_merged_and_format_address(firm, layered):
    org = firm["org"]
    dup = make_party(
        org,
        "Ava  Calder",
        birth_date=date(1971, 4, 12),
        address={"line1": "22 Wolseley Rd", "locality": "Point Piper", "country": "AU"},
    )
    clients_api.merge_parties(org.id, layered["ava"].id, [dup.id], actor(firm))
    ids = {r.id for r in clients_api.party_records(org.id)}
    assert str(dup.id) not in ids
    rec = clients_api.party_records(org.id, party_ids=[dup.id], active_only=False)[0]
    assert rec.address == "22 Wolseley Rd, Point Piper, AU"


def test_merge_repoints_and_split_restores(firm, layered):
    org = firm["org"]
    dup = make_party(org, "Ava Calder (import)")
    other = make_client_record(firm, "Greenfield Estates Pty Ltd")
    rel = link(org, dup, other.party, pct=70)
    clients_api.merge_parties(org.id, layered["ava"].id, [dup.id], actor(firm))
    rel.refresh_from_db()
    assert rel.from_party_id == layered["ava"].id
    assert Party.objects.get(id=dup.id).merged_into_id == layered["ava"].id
    assert ClientParty.objects.filter(client=other, party=layered["ava"]).exists()
    restored = clients_api.split_party(org.id, layered["ava"].id, [dup.id], actor(firm))
    rel.refresh_from_db()
    assert restored == [dup.id]
    assert rel.from_party_id == dup.id
    assert Party.objects.get(id=dup.id).merged_into_id is None
    assert set(AuditLog.objects.values_list("action", flat=True)) >= {"party.merged", "party.split"}


def test_merge_rejects_other_org_ids(firm, other_firm, layered):
    stranger = make_party(other_firm["org"], "Ava Calder")
    with pytest.raises(NotFound):
        clients_api.merge_parties(firm["org"].id, layered["ava"].id, [stranger.id], actor(firm))


def test_client_party_ids_and_not_found(firm, layered):
    ids = clients_api.client_party_ids(firm["org"].id, layered["client"].id)
    assert ids[0] == layered["client"].party_id
    assert len(ids) == 4
    with pytest.raises(NotFound):
        clients_api.client_party_ids(firm["org"].id, firm["org"].id)


def test_set_client_rating_fills_review_and_syncs_edd(firm, layered):
    client = layered["client"]
    today = timezone.localdate()
    trig = [{"code": "high_risk_jurisdiction", "message": "Offshore layer", "measures": ["source_of_funds"]}]
    clients_api.set_client_rating(firm["org"].id, client.id, "high", today, edd_triggers=trig)
    client.refresh_from_db()
    assert client.rating == "high"
    assert client.rating_source == "rules"
    assert (
        client.next_review_on == date(today.year + 1, today.month, min(today.day, 28)) or client.next_review_on > today
    )
    edd = EddCase.objects.get(client=client)
    assert edd.status == "in_progress"
    assert set(edd.measures.values_list("key", flat=True)) == {"source_of_funds", "senior_approval"}
    assert client.edd_required is True


def test_set_client_rating_validates(firm, layered):
    with pytest.raises(ValueError, match="rating must be"):
        clients_api.set_client_rating(firm["org"].id, layered["client"].id, "extreme", timezone.localdate())


def test_set_review_dates_and_block(firm, layered):
    org_id = firm["org"].id
    due = timezone.localdate() + timedelta(days=30)
    clients_api.set_review_dates(org_id, layered["client"].id, next_review_on=due)
    clients_api.block_client(org_id, layered["client"].id, "sanctions_true_match", actor(firm))
    client = Client.objects.get(id=layered["client"].id)
    assert client.next_review_on == due
    assert client.status == "blocked"
    assert AuditLog.objects.filter(action="client.blocked").count() == 1


def test_registry_search_and_import(firm):
    hits = registry.search("au_abr", "wattle")
    assert hits
    assert hits[0]["sample"] is True
    client = make_client_record(firm, hits[0]["name"])
    first = registry.import_entry(client, "au_abr", hits[0]["reference"])
    assert first["relationships_created"] >= 3
    again = registry.import_entry(client, "au_abr", hits[0]["reference"])
    assert again == {"parties_created": 0, "relationships_created": 0}
    client.party.refresh_from_db()
    assert client.party.identifiers["acn"]


def test_registry_uk_psc_chain(firm):
    client = make_client_record(firm, "Thamesgate Property Holdings Ltd")
    registry.import_entry(client, "uk_ch", "14827360")
    nominees = Party.objects.get(org=firm["org"], name="Aldgate Nominees Ltd")
    assert Relationship.objects.filter(from_party=nominees, to_party=client.party, pct=75.0).exists()
    assert Relationship.objects.filter(to_party=nominees, role="significant_control").exists()


def test_retention_preview_and_run(firm):
    org = firm["org"]
    old = make_client_record(
        firm,
        "Coastal Conveyancing Co",
        kind="partnership",
        status="exited",
        relationship_ended_on=timezone.localdate() - timedelta(days=365 * 8),
    )
    recent = make_client_record(
        firm, "Recent Exit Pty Ltd", status="exited", relationship_ended_on=timezone.localdate() - timedelta(days=700)
    )
    person = make_party(org, "Ross Keane", birth_date=date(1960, 10, 12))
    link(org, person, old.party, pct=50)
    services.rebuild_structure(org.id)
    data = retention.preview(org)
    assert data["due_count"] == 1
    assert {i["id"] for i in data["items"]} >= {str(old.id), str(recent.id)}
    dry = retention.run(org.id, dry_run=True)
    assert dry["anonymised_clients"] == 0
    assert dry["due_clients"] == 1
    done = retention.run(org.id, dry_run=False)
    assert done["anonymised_clients"] == 1
    person.refresh_from_db()
    assert person.name == retention.DISPOSED_NAME
    assert person.birth_date is None


def test_retention_respects_legal_hold(firm):
    org = firm["org"]
    make_client_record(
        firm,
        "Held Pty Ltd",
        status="exited",
        legal_hold=True,
        relationship_ended_on=timezone.localdate() - timedelta(days=365 * 9),
    )
    assert retention.preview(org)["due_count"] == 0
    assert Document.objects.count() == 0
