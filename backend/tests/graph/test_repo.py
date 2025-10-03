"""Portable Cypher repository on the embedded engine: writes, point-in-time reads, isolation."""

from __future__ import annotations

import json
from datetime import date

import pytest

from graph.repo import GraphRepo
from graph.store import LadybugStore, normalise_element

pytestmark = pytest.mark.graph


def party(org, pid, kind="company", name=None, **kw):
    return {
        "id": pid,
        "orgId": org,
        "kind": kind,
        "name": name or pid,
        "normName": (name or pid).lower(),
        "jurisdiction": kw.get("j", "AU"),
        "identifiers": json.dumps(kw.get("ids", {})),
        "birthDate": None,
        "nationality": None,
        "isNominee": kw.get("nominee", False),
        "dormant": kw.get("dormant", False),
        "source": "test",
        "sourceRef": None,
    }


def edge(org, eid, a, b, kind="ownership", pct=None, role=None, vf="2020-01-01", vt=None, nominee=False):
    return {
        "id": eid,
        "orgId": org,
        "fromId": a,
        "toId": b,
        "kind": kind,
        "pct": pct,
        "role": role,
        "validFrom": vf,
        "validTo": vt,
        "nominee": nominee,
    }


@pytest.fixture
def repo(store):
    r = GraphRepo(store, "o1")
    r.upsert_parties(
        [
            party("o1", "p", "person", "Paula Owner"),
            party("o1", "a", name="Alpha Pty Ltd"),
            party("o1", "c", name="Client Pty Ltd"),
            party("o1", "d", name="Dormant Co", dormant=True),
        ]
    )
    r.replace_edges(
        [
            edge("o1", "e1", "p", "a", pct=100),
            edge("o1", "e2", "a", "c", pct=60, vf="2021-01-01"),
            edge("o1", "e3", "p", "c", pct=40, vf="2018-01-01", vt="2022-06-30"),
            edge("o1", "k1", "p", "c", "control", role="director"),
            edge("o1", "k2", "p", "d", "control", role="director"),
        ]
    )
    return r


def test_upstream_respects_as_of(repo):
    early = repo.upstream(["c"], date(2020, 6, 1))
    assert {e.id for e in early.edges.values()} == {"e3", "k1"}
    late = repo.upstream(["c"], date(2023, 1, 1))
    assert {e.id for e in late.edges.values()} == {"e2", "e1", "k1"}


def test_validity_end_day_is_exclusive(repo):
    assert "e3" in repo.upstream(["c"], date(2022, 6, 29)).edges
    assert "e3" not in repo.upstream(["c"], date(2022, 6, 30)).edges


def test_replace_edges_is_idempotent_and_moves_endpoints(repo):
    repo.replace_edges([edge("o1", "e2", "a", "c", pct=60, vf="2021-01-01")])
    repo.replace_edges([edge("o1", "e2", "a", "c", pct=60, vf="2021-01-01")])
    assert sum(1 for e in repo.edges_any_time(["c"]) if e.id == "e2") == 1
    repo.replace_edges([edge("o1", "e2", "d", "c", pct=60)])
    moved = next(e for e in repo.edges_any_time(["c"]) if e.id == "e2")
    assert moved.src == "d"


def test_control_only_batch_without_percentages(repo):
    repo.replace_edges([edge("o1", "k9", "a", "c", "control", role="secretary")])
    assert any(e.id == "k9" and e.pct is None for e in repo.edges_any_time(["c"]))


def test_delete_party_detaches_edges(repo):
    repo.delete_party("a")
    assert all(e.src != "a" and e.dst != "a" for e in repo.edges_any_time(["c", "p"]))


def test_addresses_are_shared_and_pruned(repo):
    addr = {"id": "addr:1", "label": "1 Shared St", "postcode": "2000", "country": "AU"}
    repo.set_addresses([{"partyId": "a", "address": addr}, {"partyId": "c", "address": addr}])
    assert repo.address_sizes() == [("addr:1", "1 Shared St", 2)]
    repo.set_addresses([{"partyId": "a", "address": None}, {"partyId": "c", "address": None}])
    repo.prune_addresses()
    assert repo.address_sizes() == []


def test_search_matches_normalised_names_and_identifiers(store):
    r = GraphRepo(store, "o2")
    r.upsert_parties([party("o2", "x", name="Harbour Quay Pty Ltd", ids={"acn": "619004111"})])
    assert [n.id for n in r.search("harbour quay", 5)] == ["x"]
    assert [n.id for n in r.search("619004111", 5)] == ["x"]


def test_orgs_are_isolated(store, repo):
    other = GraphRepo(store, "o2")
    other.upsert_parties([party("o2", "q", name="Other Firm Client")])
    assert other.nodes(["p", "a", "c"]) == {}
    assert repo.nodes(["q"]) == {}
    assert other.search("client", 5)[0].id == "q"


def test_changes_between_dates(repo):
    ids = sorted(e.id for e in repo.edges_changed_between(date(2020, 12, 31), date(2022, 12, 31)))
    assert ids == ["e2", "e3"]


def test_appointment_counts_include_dormant(repo):
    counts = repo.appointment_counts(["p"], date(2023, 1, 1), ["director"])
    assert counts["p"] == (2, 1)


def test_depth_limit_sets_truncated(store):
    r = GraphRepo(store, "o3", max_depth=2)
    r.upsert_parties([party("o3", f"n{i}") for i in range(5)])
    r.replace_edges([edge("o3", f"e{i}", f"n{i + 1}", f"n{i}", pct=100) for i in range(4)])
    sub = r.upstream(["n0"], date(2023, 1, 1))
    assert sub.truncated and set(sub.nodes) == {"n0", "n1", "n2"}


def test_neighbours_include_address_links(repo):
    repo.set_addresses(
        [{"partyId": "a", "address": {"id": "addr:2", "label": "2 St", "postcode": None, "country": "AU"}}]
    )
    kinds = {e.kind for e in repo.neighbours_any(["a"], date(2023, 1, 1))}
    assert kinds == {"ownership", "address"}


def test_read_only_handle_rejects_writes(tmp_path):
    path = tmp_path / "ro.lbug"
    w = LadybugStore(path)
    w.ensure_schema()
    w.close()
    ro = LadybugStore(path, read_only=True)
    with pytest.raises(RuntimeError):
        ro.execute("MERGE (n:Party {id: 'x'})")
    ro.close()


def test_normalise_element_strips_engine_keys():
    assert normalise_element({"_ID": {"offset": 0}, "_LABEL": "Party", "id": "x"}) == {"id": "x", "_label": "Party"}


def test_reused_ids_never_inherit_another_firms_edges(store):
    old = GraphRepo(store, "old-org")
    old.upsert_parties([party("old-org", "x"), party("old-org", "y")])
    old.replace_edges([edge("old-org", "e-old", "x", "y", pct=100)])
    new = GraphRepo(store, "new-org")
    new.upsert_parties([party("new-org", "x"), party("new-org", "y")])
    assert new.upstream(["y"], date(2023, 1, 1)).edges == {}
    assert old.nodes(["x", "y"]) == {}
