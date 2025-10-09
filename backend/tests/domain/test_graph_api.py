"""graph.api through Django: outbox sync, client views, UBOs, diffs, threads, connections, clusters, search."""

from __future__ import annotations

import uuid
from datetime import date

import pytest

from graph import api as graph
from graph.models import GraphOutbox
from kinroot.contracts import NotFound

from .builder import World

pytestmark = [pytest.mark.django_db, pytest.mark.graph]


def test_signals_write_outbox_rows_and_reads_apply_them(world):
    world.person("p", "Pat Lee")
    world.company("c", "Lee Co Pty Ltd")
    world.own("p", "c", 100)
    assert GraphOutbox.objects.filter(org=world.org).count() == 3
    world.client("c", "c")
    view = graph.client_graph(world.org_id, world.c["c"].id)
    assert {n.label for n in view.nodes} >= {"Pat Lee", "Lee Co Pty Ltd"}
    assert not GraphOutbox.objects.filter(org=world.org, applied_at__isnull=True).exists()
    assert graph.sync_status(world.org_id).graph_version > 0


def test_client_graph_flags_and_effective_pct(hq):
    view = graph.client_graph(hq.org_id, hq.c["harbour-quay"].id)
    nodes = {n.label: n for n in view.nodes}
    assert "ubo" in nodes["Ava Calder"].flags and "ubo" in nodes["Ben Okafor"].flags
    assert nodes["Ava Calder"].effective_pct == 49.6
    assert "offshore" in nodes["Kestrel Ventures Ltd"].flags
    assert "nominee" in nodes["Gregory Pell"].flags
    assert "client" in nodes["Harbour Quay Developments Pty Ltd"].flags
    assert nodes["Harbour Quay Developments Pty Ltd"].level == 0
    assert any(e.kind == "address" for e in view.edges)
    own = next(e for e in view.edges if e.kind == "ownership" and e.pct == 62)
    assert own.label == "62%" and own.valid_from == date(2019, 1, 1)


def test_beneficial_owners_with_paths_and_explanations(hq):
    r = graph.beneficial_owners(hq.org_id, hq.c["harbour-quay"].id)
    by = {o.name: o for o in r.owners}
    assert by["Ava Calder"].effective_pct == 49.6 and by["Ava Calder"].via == "both"
    assert set(by["Ava Calder"].control_roles) >= {"appointor"}
    assert by["Ben Okafor"].effective_pct == 30.4 and by["Ben Okafor"].is_ubo
    assert r.unexplained_pct == 20.0
    assert "nominee_in_chain" in r.warnings
    assert "Ava Calder holds 100% of Calder Family Trust" in by["Ava Calder"].paths[0].sentence
    assert by["Ava Calder"].paths[0].effective_pct == 49.6


def test_point_in_time_before_offshore_layer(hq):
    r = graph.beneficial_owners(hq.org_id, hq.c["harbour-quay"].id, as_of=date(2020, 6, 1))
    assert r.owners == []


def test_graph_diff_reports_added_edges_with_sentences(hq):
    d = graph.graph_diff(hq.org_id, hq.c["harbour-quay"].id, date(2020, 6, 1), date(2021, 6, 1))
    assert any(e.id == str(hq.r["kes>hq"].id) for e in d.added)
    assert any("became a 100% owner of Harbour Quay" in s for s in d.summary)


def test_graph_diff_detects_changed_percentage(world):
    world.person("a", "Ann")
    world.company("c", "Change Co")
    world.own("a", "c", 40, since="2019-01-01", until="2022-01-01")
    world.own("a", "c", 70, since="2022-01-01")
    world.client("c", "c")
    d = graph.graph_diff(world.org_id, world.c["c"].id, date(2021, 1, 1), date(2023, 1, 1))
    assert len(d.changed) == 1 and d.changed[0].fields == ["pct"]
    assert "changed from 40% to 70%" in d.summary[0]


def test_graph_diff_rejects_reversed_dates(hq):
    with pytest.raises(ValueError):
        graph.graph_diff(hq.org_id, hq.c["harbour-quay"].id, date(2023, 1, 1), date(2022, 1, 1))


def test_pull_the_thread_reaches_every_client(hq):
    hq.client("bellmere", "bell")
    t = graph.pull_thread(hq.org_id, hq.p["ava"].id)
    by = {e.client_name: e for e in t.entries}
    assert by["Harbour Quay Developments Pty Ltd"].effective_pct == 49.6
    assert by["Bellmere Holdings Pty Ltd"].effective_pct == 62.0
    assert str(hq.r["kes>hq"].id) in t.edge_ids


def test_connection_finds_shortest_path_including_shared_address(hq):
    c = graph.connection(hq.org_id, hq.p["ben"].id, hq.p["pell"].id)
    assert c.found and len(c.paths[0].hops) == 3
    hq.company(
        "other",
        "Mahe Shelf Co Ltd",
        jurisdiction="SC",
        address={"line1": "Suite 4, 88 Victoria St", "locality": "Mahe", "country": "SC"},
    )
    via_addr = graph.connection(hq.org_id, hq.p["other"].id, hq.p["pell"].id)
    assert via_addr.found and via_addr.paths[0].hops[0].kind == "address"


def test_connection_not_found_and_same_party(world):
    world.person("a", "Lonely One")
    world.person("b", "Lonely Two")
    assert graph.connection(world.org_id, world.p["a"].id, world.p["b"].id).found is False
    assert graph.connection(world.org_id, world.p["a"].id, world.p["a"].id).found is True


def test_clusters_shared_officer_address_and_nominee(world):
    addr = {"line1": "Suite 4, 88 Victoria St", "locality": "Mahe", "country": "SC"}
    world.person("pell", "Gregory Pell", is_nominee=True, address=addr)
    for i in range(4):
        world.company(f"co{i}", f"Shelf {i} Ltd", jurisdiction="SC", address=addr, dormant=True)
        world.control("pell", f"co{i}", "director", nominee=True)
    world.client("c0", "co0")
    cl = {c.kind: c for c in graph.clusters(world.org_id)}
    assert cl["shared_officer"].size == 4 and cl["shared_officer"].label == "Gregory Pell directs 4 companies"
    assert cl["shared_address"].size == 5
    assert cl["nominee"].size == 4
    assert str(world.c["c0"].id) in cl["shared_officer"].client_ids
    assert graph.clusters(world.org_id, kinds=["shared_address"], min_size=10) == []


def test_constellation_joins_clients_through_shared_owner(hq):
    hq.person("ben2", "Unrelated Person")
    hq.company("g", "Greenfield Estates Pty Ltd")
    hq.own("ben", "g", 70)
    hq.client("g", "g")
    view = graph.constellation(hq.org_id)
    labels = {n.label for n in view.nodes}
    assert {"Harbour Quay Developments Pty Ltd", "Greenfield Estates Pty Ltd", "Ben Okafor"} <= labels
    assert "Unrelated Person" not in labels
    assert any(e.label == "Shared owner" for e in view.edges)


def test_search_puts_clients_first_and_tolerates_typos(hq):
    res = graph.search(hq.org_id, "bellmere")
    assert res[0].label == "Bellmere Holdings Pty Ltd"
    hq.client("bellmere", "bell")
    res = graph.search(hq.org_id, "calder")
    assert res and all("calder" in n.label.lower() for n in res)
    assert graph.search(hq.org_id, "Kestral Ventures")[0].label.startswith("Kestrel")
    assert graph.search(hq.org_id, "   ") == []


def test_graph_features_for_risk(hq):
    f = graph.graph_features(hq.org_id, hq.c["harbour-quay"].id)
    assert f.n_layers_to_ubo == 4 and f.n_ubos == 2
    assert f.n_offshore_entities == 1 and "VG" in f.high_risk_jurisdictions
    assert f.trust_in_chain and f.nominee_indicators >= 2
    assert f.unexplained_pct == 20.0 and not f.has_cycle


def test_other_org_ids_behave_as_missing(hq):
    other = World("Other")
    other.person("x", "Someone Else")
    with pytest.raises(NotFound):
        graph.client_graph(other.org_id, hq.c["harbour-quay"].id)
    with pytest.raises(NotFound):
        graph.party_graph(other.org_id, hq.p["ava"].id)
    with pytest.raises(NotFound):
        graph.beneficial_owners(hq.org_id, uuid.uuid4())


def test_party_graph_expands_both_directions(hq):
    view = graph.party_graph(hq.org_id, hq.p["bell"].id, depth=1)
    labels = {n.label for n in view.nodes}
    assert {"Calder Family Trust", "Ben Okafor", "Kestrel Ventures Ltd"} <= labels


def test_merged_party_disappears_from_graph(hq):
    from clients import api as clients

    hq.person("ben_dup", "Benjamin Okafor")
    clients.merge_parties(hq.org_id, hq.p["ben"].id, [hq.p["ben_dup"].id], hq.actor())
    res = graph.search(hq.org_id, "benjamin okafor")
    assert all(n.id != hq.id("ben_dup") for n in res)


def test_rebuild_org_reprojects_everything(hq):
    n = graph.rebuild_org(hq.org_id)
    assert n >= 8 + 9
    r = graph.beneficial_owners(hq.org_id, hq.c["harbour-quay"].id)
    assert {o.name for o in r.owners if o.is_ubo} == {"Ava Calder", "Ben Okafor"}


def test_ending_a_relationship_updates_the_graph(hq):
    rel = hq.r["ben>bell"]
    rel.valid_to = date(2024, 1, 1)
    rel.save()
    r = graph.beneficial_owners(hq.org_id, hq.c["harbour-quay"].id, as_of=date(2024, 6, 1))
    assert "Ben Okafor" not in {o.name for o in r.owners}


def test_edges_are_numbered_nearest_the_client_first(hq):
    """E-01, E-02 … follow the payload order, so it must be stable and readable: hop 1 before hop 2."""
    view = graph.client_graph(hq.org_id, hq.c["harbour-quay"].id)
    level = {n.id: n.level for n in view.nodes}
    parties = [e for e in view.edges if e.kind != "address" and not e.id.startswith(("unknown-", "stack-"))]
    assert parties[0].target == str(hq.p["hq"].id) and parties[0].source == str(hq.p["kes"].id)
    targets = [level[e.target] for e in parties]
    assert targets == sorted(targets)
    again = graph.client_graph(hq.org_id, hq.c["harbour-quay"].id)
    assert [e.id for e in again.edges] == [e.id for e in view.edges]


def test_missing_shareholders_become_an_unknown_group(hq):
    """Kestrel Ventures has 80% on record: the other 20% is drawn as "Unknown shareholders"."""
    view = graph.client_graph(hq.org_id, hq.c["harbour-quay"].id)
    kes = str(hq.p["kes"].id)
    unknown = next(n for n in view.nodes if n.kind == "unknown")
    assert unknown.id == f"unknown:{kes}" and unknown.label == "Unknown shareholders"
    edge = next(e for e in view.edges if e.source == unknown.id)
    assert edge.target == kes and edge.label == "20%" and edge.pct is None


def test_undisclosed_holder_is_drawn_as_unknown(world):
    world.person("g", "Gareth Lloyd")
    world.party("bearer", "other", "Undisclosed bearer shareholder")
    world.company("sb", "Southbank Holdings Pty Ltd")
    world.own("g", "sb", 70)
    world.own("bearer", "sb", 30)
    world.client("sb", "sb")
    view = graph.client_graph(world.org_id, world.c["sb"].id)
    node = next(n for n in view.nodes if n.id == str(world.p["bearer"].id))
    assert node.kind == "unknown" and node.label == "Unknown shareholders"
    assert "Undisclosed bearer shareholder" in (node.sub or "")
    assert not any(n.id.startswith("unknown:") for n in view.nodes)


def test_busy_officer_gets_a_stack_of_other_companies(world):
    world.person("pell", "Gregory Pell", is_nominee=True)
    world.company("lumen", "Lumen Trade Pty Ltd")
    world.control("pell", "lumen", "director")
    for i in range(6):
        world.company(f"d{i}", f"Dormant Shell {i} Ltd", dormant=True)
        world.control("pell", f"d{i}", "director")
    world.client("lumen", "lumen")
    view = graph.client_graph(world.org_id, world.c["lumen"].id)
    stack = next(n for n in view.nodes if n.kind == "stack")
    assert stack.count == 6 and stack.label == "6 companies" and stack.sub == "Dormant"
    edge = next(e for e in view.edges if e.target == stack.id)
    assert edge.source == str(world.p["pell"].id) and edge.kind == "control" and edge.label == "Directs"


def test_subgraph_returns_exactly_the_cited_parties(hq):
    ids = [str(hq.p["kes"].id), str(hq.p["hq"].id), str(hq.p["bell"].id)]
    edge = str(hq.r["kes>hq"].id)
    view = graph.subgraph(hq.org_id, ids, [edge])
    assert {n.id for n in view.nodes} == set(ids)
    assert [e.id for e in view.edges] == [edge]
    other = World("Other Firm")
    assert graph.subgraph(other.org_id, ids, [edge]).nodes == []
