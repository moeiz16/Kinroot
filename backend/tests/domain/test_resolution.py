"""Entity resolution through Django: candidates, bands, the merge/split queue and labelled decisions."""

from __future__ import annotations

import uuid
from datetime import date

import pytest

from clients.models import Party
from kinroot.contracts import DomainConflict, NotFound, PartyRecord
from resolution import api as resolution
from resolution.models import MatchCandidate, MergeRecord

pytestmark = pytest.mark.django_db


@pytest.fixture
def dupes(world):
    world.person(
        "sean",
        "Sean O'Connor",
        birth_date=date(1985, 6, 1),
        address={"line1": "12 Ocean Road", "locality": "Bondi", "postcode": "2026", "country": "AU"},
    )
    world.person(
        "sean2",
        "Sean OConnor",
        birth_date=date(1985, 6, 1),
        address={"line1": "12 Ocean Rd", "locality": "Bondi", "postcode": "2026", "country": "AU"},
    )
    world.person(
        "ben",
        "Ben Okafor",
        birth_date=date(1969, 2, 14),
        address={"line1": "4 King St", "locality": "Sydney", "postcode": "2000", "country": "AU"},
    )
    world.person(
        "ben2",
        "Benjamin Okafor",
        birth_date=date(1969, 2, 14),
        address={"line1": "77 Swan Rd", "locality": "Perth", "postcode": "6000", "country": "AU"},
    )
    world.person("m1", "Murray Chen", birth_date=date(1975, 3, 2))
    world.person("m2", "Murray Cheng", birth_date=date(1981, 11, 19))
    world.company("c", "Ocean Holdings Pty Ltd")
    world.own("sean", "c", 100)
    world.client("ocean", "c")
    return world


def test_score_pair_is_pure_and_explained():
    a = PartyRecord(id="1", kind="person", name="Ava Calder", birth_date=date(1972, 4, 9))
    b = PartyRecord(id="2", kind="person", name="Ava Calder", birth_date=date(1972, 4, 9))
    s1, s2 = resolution.score_pair(a, b), resolution.score_pair(a, b)
    assert s1 == s2 and s1.probability > 0.9
    assert s1.reasons and s1.reasons[0].label and s1.model_version == resolution.thresholds().model_version
    assert s1.fs_weight > 0


def test_find_candidates_bands(dupes):
    n = resolution.find_candidates(dupes.org_id)
    assert n >= 3
    status = {
        frozenset((c.left.name, c.right.name)): (c.band, c.status)
        for c in MatchCandidate.objects.filter(org=dupes.org).select_related("left", "right")
    }
    assert status[frozenset(("Sean O'Connor", "Sean OConnor"))] == ("auto_merge", "auto_merged")
    assert status[frozenset(("Ben Okafor", "Benjamin Okafor"))] == ("review", "pending")
    assert status[frozenset(("Murray Chen", "Murray Cheng"))] == ("reject", "not_match")
    survivor = Party.objects.get(id=dupes.p["sean"].id)
    assert survivor.merged_into_id is None and Party.objects.get(id=dupes.p["sean2"].id).merged_into_id == survivor.id
    assert MergeRecord.objects.filter(org=dupes.org, survivor=survivor).exists()


def test_find_candidates_is_idempotent(dupes):
    resolution.find_candidates(dupes.org_id)
    count = MatchCandidate.objects.filter(org=dupes.org).count()
    resolution.find_candidates(dupes.org_id)
    assert MatchCandidate.objects.filter(org=dupes.org).count() == count


def test_queue_lists_pending_by_probability(dupes):
    resolution.find_candidates(dupes.org_id)
    page = resolution.list_candidates(dupes.org_id)
    assert page.total == 1 and page.items[0].left.name in ("Ben Okafor", "Benjamin Okafor")
    assert page.items[0].score.reasons
    assert resolution.list_candidates(dupes.org_id, status=None, band="reject").total == 1


def test_decide_merge_then_already_decided(dupes):
    resolution.find_candidates(dupes.org_id)
    cand = resolution.list_candidates(dupes.org_id).items[0]
    actor = dupes.actor("co")
    out = resolution.decide(dupes.org_id, cand.id, "merge", actor, "Same DOB, moved interstate")
    assert out.status == "merged" and len(out.merged_ids) == 1
    view = resolution.get_candidate(dupes.org_id, cand.id)
    assert view.decided_by == "Co" and view.note == "Same DOB, moved interstate"
    with pytest.raises(DomainConflict) as exc:
        resolution.decide(dupes.org_id, cand.id, "not_match", actor)
    assert exc.value.code == "already_decided"


def test_decide_not_match_and_defer(dupes):
    resolution.find_candidates(dupes.org_id)
    cand = resolution.list_candidates(dupes.org_id).items[0]
    assert resolution.decide(dupes.org_id, cand.id, "defer", dupes.actor("co")).status == "deferred"
    assert resolution.decide(dupes.org_id, cand.id, "not_match", dupes.actor("co")).status == "not_match"
    with pytest.raises(ValueError):
        resolution.decide(dupes.org_id, cand.id, "maybe", dupes.actor("co"))  # type: ignore[arg-type]


def test_propose_merge_opens_pending_candidate_even_if_unlikely(dupes):
    view = resolution.propose_merge(dupes.org_id, dupes.p["m1"].id, dupes.p["ben"].id, dupes.actor("co"))
    assert view.status == "pending" and view.score.band == "reject"
    with pytest.raises(ValueError):
        resolution.propose_merge(dupes.org_id, dupes.p["m1"].id, dupes.p["m1"].id, dupes.actor("co"))


def test_split_restores_merged_record(dupes):
    resolution.find_candidates(dupes.org_id)
    survivor = dupes.p["sean"].id
    out = resolution.split(
        dupes.org_id, survivor, [dupes.p["sean2"].id], dupes.actor("co"), "Different people after all"
    )
    assert out.merged_ids == [str(dupes.p["sean2"].id)]
    assert Party.objects.get(id=dupes.p["sean2"].id).merged_into_id is None
    assert MergeRecord.objects.get(merged=dupes.p["sean2"]).undone_at is not None


def test_queue_stats_and_thresholds(dupes):
    resolution.find_candidates(dupes.org_id)
    s = resolution.queue_stats(dupes.org_id)
    assert s["pending"] == 1 and s["autoMergedLast30d"] == 1 and 0 <= s["reviewRate"] <= 1
    t = resolution.thresholds()
    assert t.review < t.auto_merge and "precision" in t.chosen_by


def test_client_filter_and_other_org(dupes):
    resolution.find_candidates(dupes.org_id)
    assert resolution.list_candidates(dupes.org_id, status=None, client_id=dupes.c["ocean"].id).total >= 1
    with pytest.raises(NotFound):
        resolution.get_candidate(uuid.uuid4(), MatchCandidate.objects.filter(org=dupes.org).first().id)


def test_auto_merge_can_be_disabled(dupes):
    dupes.org.settings = {"resolution": {"auto_merge_enabled": False}}
    dupes.org.save()
    resolution.find_candidates(dupes.org_id)
    assert not MatchCandidate.objects.filter(org=dupes.org, status="auto_merged").exists()


def test_company_and_trust_never_paired(world):
    world.company("co", "Whitfield Super Pty Ltd")
    world.party("tr", "trust", "Whitfield Super Fund")
    resolution.find_candidates(world.org_id)
    assert not MatchCandidate.objects.filter(org=world.org).exists()
