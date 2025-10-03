"""Screening: bundled lists, matching with corroboration, hit review and its consequences."""

from __future__ import annotations

from datetime import date

import pytest

from cases.models import Concern
from clients.models import Client
from kinroot.contracts import DomainConflict, NotFound
from monitoring.models import Alert
from screening import api as screening
from screening.matcher import Entry, ListIndex, name_similarity, score_entry, screen, tokens_for
from screening.models import ListVersion, ScreeningHit

pytestmark = pytest.mark.django_db


@pytest.fixture
def book(world):
    world.company("aur", "Aurelian Maritime FZE", jurisdiction="AE")
    world.company("ship", "Aurelian Shipping Pty Ltd")
    world.own("aur", "ship", 100)
    world.client("aurelian", "ship")
    world.person("petrov", "Alexei Petrov", birth_date=date(1984, 5, 17), nationality="AU", jurisdiction="AU")
    world.client("petrov", "petrov")
    world.person("jw", "Hon. Julian Whitfield", birth_date=date(1961, 8, 3), nationality="AU", jurisdiction="AU")
    world.client("whitfield", "jw")
    world.person("plain", "Linh Nguyen", birth_date=date(1990, 10, 5), nationality="AU")
    world.client("linh", "plain")
    return world


def hit_for(world, key):
    return ScreeningHit.objects.get(org=world.org, party=world.p[key])


def test_load_lists_is_idempotent_and_versioned():
    v1 = screening.load_lists()
    count = ListVersion.objects.count()
    assert screening.load_lists() == v1 and ListVersion.objects.count() == count
    lists = screening.list_versions()
    assert {v["list"] for v in lists} == {"sanctions", "pep"}
    assert all(v["sample"] and "Not real list data" in v["attribution"] for v in lists)


def test_screen_client_raises_near_match_hits(book):
    r = screening.screen_client(book.org_id, book.c["aurelian"].id, book.actor("co"))
    assert r.new_hits == 1 and r.screened_parties == 2
    h = hit_for(book, "aur")
    assert h.entry_key == "SAMPLE-SAN-0007" and h.score >= 0.95 and h.status == "pending"
    assert any("FZCO" in r["label"] for r in h.reasons)


def test_namesake_with_different_birth_year_is_raised_with_reasons(book):
    screening.screen_client(book.org_id, book.c["petrov"].id, book.actor("co"))
    h = hit_for(book, "petrov")
    labels = [r["label"] for r in h.reasons]
    assert h.entry_key == "SAMPLE-SAN-0012" and 0.82 <= h.score < 0.9
    assert any("Different birth year" in lbl for lbl in labels) and any("Different country" in lbl for lbl in labels)


def test_clean_client_has_no_hits_and_rescreen_adds_nothing(book):
    assert screening.screen_client(book.org_id, book.c["linh"].id, book.actor("co")).new_hits == 0
    screening.screen_client(book.org_id, book.c["aurelian"].id, book.actor("co"))
    assert screening.screen_org(book.org_id, book.actor("co")).new_hits == 2  # Petrov and Whitfield are new
    assert screening.screen_org(book.org_id, book.actor("co")).new_hits == 0


def test_list_update_hits_raise_alerts(book):
    screening.screen_org(book.org_id, book.actor("co"), reason="list_update")
    assert Alert.objects.filter(org=book.org, kind="list_update_hit").count() == 3


def test_true_sanctions_match_blocks_client_and_raises_critical_alert(book):
    screening.screen_client(book.org_id, book.c["aurelian"].id, book.actor("co"))
    h = hit_for(book, "aur")
    view = screening.review_hit(
        book.org_id, h.id, "true_match", "Same free-zone registration and director", book.actor("co")
    )
    assert view.status == "true_match" and view.reviewed_by == "Co"
    assert Client.objects.get(id=book.c["aurelian"].id).status == "blocked"
    assert Alert.objects.filter(org=book.org, severity="critical", client=book.c["aurelian"]).exists()


def test_pep_true_match_feeds_risk(book):
    screening.screen_client(book.org_id, book.c["whitfield"].id, book.actor("co"))
    h = hit_for(book, "jw")
    screening.review_hit(
        book.org_id, h.id, "true_match", "Confirmed member of the Legislative Council", book.actor("co")
    )
    from risk import api as risk

    a = risk.latest_assessment(book.org_id, book.c["whitfield"].id)
    assert a is not None and a.rating == "high" and any(t.code == "pep" for t in a.edd_triggers)


def test_escalation_raises_a_concern_and_review_rules(book):
    screening.screen_client(book.org_id, book.c["petrov"].id, book.actor("co"))
    h = hit_for(book, "petrov")
    with pytest.raises(ValueError):
        screening.review_hit(book.org_id, h.id, "false_positive", "too short", book.actor("co"))
    assert (
        screening.review_hit(
            book.org_id, h.id, "escalate", "Needs a second look at the passport", book.actor("co")
        ).status
        == "escalated"
    )
    assert Concern.objects.filter(org=book.org).exists()
    assert (
        screening.review_hit(
            book.org_id, h.id, "false_positive", "Different person: born 1984 in Australia", book.actor("co")
        ).status
        == "false_positive"
    )
    with pytest.raises(DomainConflict):
        screening.review_hit(book.org_id, h.id, "true_match", "Changing my mind again", book.actor("co"))


def test_list_hits_filters_and_entry_lookup(book):
    screening.screen_org(book.org_id, book.actor("co"))
    assert screening.list_hits(book.org_id, list_kind="sanctions").total == 2
    assert screening.list_hits(book.org_id, client_id=book.c["petrov"].id).total == 1
    assert screening.get_entry("SAMPLE-PEP-0003").list_kind == "pep"
    with pytest.raises(NotFound):
        screening.get_entry("NOPE")


ENTRIES = [
    Entry("S1", "sanctions", "Company", "Caspian Bridge Holdings Ltd", [], "", ["CY"]),
    Entry("S2", "sanctions", "Person", "Dmitri Arkadyevich Sorokin", ["Dmitry Sorokin"], "1961-03-14", ["RU"]),
    Entry("S3", "sanctions", "Person", "Kwon Chol-Jin", [], "1968", ["KP"]),
    Entry("P1", "pep", "Person", "Hon. Margaret Ellison", [], "1957-05-11", ["AU"]),
]


def test_matcher_ignores_generic_company_words():
    idx = ListIndex(ENTRIES)
    assert screen(idx, {"kind": "company", "name": "Cayman Ridge Holdings Ltd", "jurisdiction": "KY"}) == []
    assert tokens_for("Cayman Ridge Holdings Ltd", False) == ("cayman", "ridge")


def test_matcher_handles_order_initials_and_aliases():
    idx = ListIndex(ENTRIES)
    assert screen(idx, {"kind": "person", "name": "Chol Jin Kwon"})[0][0].id == "S3"
    assert screen(idx, {"kind": "person", "name": "D A Sorokin"})[0][0].id == "S2"


def test_full_birth_date_mismatch_suppresses_a_name_only_match():
    e = ENTRIES[1]
    same, _ = score_entry(
        {"kind": "person", "name": "Dmitry Sorokin", "birth_date": "1961-03-14", "nationality": "RU"}, e
    )
    other, _ = score_entry(
        {"kind": "person", "name": "Dmitry Sorokin", "birth_date": "1990-07-01", "nationality": "AU"}, e
    )
    assert same == 1.0 and other < 0.82


def test_people_never_match_companies_and_similar_surnames_score_lower():
    idx = ListIndex(ENTRIES)
    assert screen(idx, {"kind": "company", "name": "Margaret Ellison"}) == []
    assert name_similarity(("margaret", "ellis"), ("margaret", "ellison")) < name_similarity(
        ("margaret", "ellison"), ("margaret", "ellison")
    )
