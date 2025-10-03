"""Pure ownership algorithms (no engine): effective ownership, cycles, paths, explanations."""

from __future__ import annotations

from graph.ownership import (
    GEdge,
    GNode,
    OwnPath,
    Subgraph,
    compute_ubo,
    downstream_reach,
    find_cycles,
    fmt_pct,
    path_sentence,
    shortest_paths,
)


def sub(nodes, edges):
    s = Subgraph()
    for nid, kind, name, *rest in nodes:
        s.add_node(GNode(nid, kind, name, jurisdiction=rest[0] if rest else None))
    for eid, a, b, kind, val in edges:
        if kind == "ownership":
            s.add_edge(GEdge(eid, a, b, "ownership", pct=val))
        else:
            s.add_edge(GEdge(eid, a, b, "control", role=val))
    return s


def test_fmt_pct_drops_trailing_zeros():
    assert fmt_pct(62.0) == "62"
    assert fmt_pct(49.6) == "49.6"
    assert fmt_pct(None) == ""


def test_effective_ownership_is_product_along_path():
    s = sub(
        [("p", "person", "P"), ("a", "company", "A"), ("c", "company", "C")],
        [("1", "p", "a", "ownership", 50), ("2", "a", "c", "ownership", 60)],
    )
    r = compute_ubo(s, "c")
    assert r.owners[0].pct == 30.0
    assert r.entity_shares["a"] == 0.6


def test_threshold_is_configurable():
    s = sub([("p", "person", "P"), ("c", "company", "C")], [("1", "p", "c", "ownership", 20)])
    assert not compute_ubo(s, "c", threshold_pct=25).owners[0].is_ubo
    assert compute_ubo(s, "c", threshold_pct=10).owners[0].is_ubo


def test_cycle_is_reported_once_and_rotated():
    s = sub(
        [("x", "company", "X"), ("y", "company", "Y"), ("z", "company", "Z")],
        [("1", "x", "y", "ownership", 50), ("2", "y", "z", "ownership", 50), ("3", "z", "x", "ownership", 50)],
    )
    cycles = find_cycles(s)
    assert cycles == [["x", "y", "z"]]


def test_two_disjoint_cycles():
    s = sub(
        [(k, "company", k.upper()) for k in "abcd"],
        [
            ("1", "a", "b", "ownership", 50),
            ("2", "b", "a", "ownership", 50),
            ("3", "c", "d", "ownership", 50),
            ("4", "d", "c", "ownership", 50),
        ],
    )
    assert len(find_cycles(s)) == 2


def test_self_loop_free_dag_has_no_cycles():
    s = sub(
        [("p", "person", "P"), ("a", "company", "A"), ("b", "company", "B")],
        [("1", "p", "a", "ownership", 100), ("2", "a", "b", "ownership", 100)],
    )
    assert find_cycles(s) == []


def test_cycle_never_loops_and_shares_stay_bounded():
    s = sub(
        [("p", "person", "P"), ("a", "company", "A"), ("b", "company", "B")],
        [("1", "p", "a", "ownership", 50), ("2", "b", "a", "ownership", 50), ("3", "a", "b", "ownership", 100)],
    )
    r = compute_ubo(s, "a")
    assert r.owners[0].pct == 50.0
    assert "circular_ownership" in r.warnings
    assert 0 <= r.unexplained_pct <= 100


def test_path_sentence_reads_owner_to_client():
    s = sub(
        [("p", "person", "Ava"), ("a", "company", "Kestrel Ltd", "VG"), ("c", "company", "Client")],
        [("1", "p", "a", "ownership", 80), ("2", "a", "c", "ownership", 100)],
    )
    r = compute_ubo(s, "c")
    text = path_sentence(s, r.owners[0].paths[0])
    assert text == "Ava holds 80% of Kestrel Ltd (British Virgin Islands), which holds 100% of Client."


def test_explanation_mentions_threshold_and_chains():
    s = sub([("p", "person", "Ava"), ("c", "company", "Client")], [("1", "p", "c", "ownership", 60)])
    r = compute_ubo(s, "c")
    text = r.explanation(s, r.owners[0])
    assert "Ava owns 60% of Client" in text and "25% threshold" in text


def test_control_role_on_client_makes_ubo_without_shares():
    s = sub([("p", "person", "P"), ("c", "company", "C")], [("1", "p", "c", "control", "significant_control")])
    r = compute_ubo(s, "c")
    assert r.owners[0].is_ubo and r.owners[0].via == "control"


def test_plain_director_is_not_ubo_when_owners_exist():
    s = sub(
        [("o", "person", "Owner"), ("d", "person", "Director"), ("c", "company", "C")],
        [("1", "o", "c", "ownership", 100), ("2", "d", "c", "control", "director")],
    )
    r = compute_ubo(s, "c")
    assert [o.party_id for o in r.owners if o.is_ubo] == ["o"]


def test_downstream_reach_sums_shares_and_records_own_roles():
    s = sub(
        [("p", "person", "P"), ("a", "company", "A"), ("b", "company", "B"), ("c", "company", "C")],
        [
            ("1", "p", "a", "ownership", 50),
            ("2", "p", "b", "ownership", 50),
            ("3", "a", "c", "ownership", 40),
            ("4", "b", "c", "ownership", 60),
            ("5", "p", "c", "control", "director"),
        ],
    )
    hits = downstream_reach(s, "p", {"c"})
    assert round(hits["c"].share, 4) == 0.5
    assert hits["c"].roles == ["director"]
    assert len(hits["c"].paths) == 3


def test_shortest_paths_prefers_fewest_hops_and_limits():
    e = lambda i, a, b: GEdge(i, a, b, "ownership", pct=50)  # noqa: E731
    adj: dict = {}
    for ed in [
        e("1", "a", "b"),
        e("2", "b", "d"),
        e("3", "a", "c"),
        e("4", "c", "d"),
        e("5", "a", "x"),
        e("6", "x", "y"),
        e("7", "y", "d"),
    ]:
        adj.setdefault(ed.src, []).append((ed.dst, ed))
        adj.setdefault(ed.dst, []).append((ed.src, ed))
    paths = shortest_paths(adj, "a", "d", max_hops=6, limit=3)
    assert len(paths) == 2 and all(len(p) == 2 for p in paths)
    assert shortest_paths(adj, "a", "d", max_hops=1) == []


def test_shortest_paths_same_node_is_empty():
    assert shortest_paths({}, "a", "a") == []


def test_own_path_pct_rounds():
    p = OwnPath(["a", "b"], [GEdge("1", "a", "b", "ownership", pct=33.333)], 0.33333)
    assert p.pct == 33.33


def test_dense_graph_enumeration_is_bounded():
    import time

    layers, width = 14, 4
    s = Subgraph()
    s.add_node(GNode("focus", "company", "Focus"))
    prev = ["focus"]
    for layer in range(layers):
        cur = [f"l{layer}n{i}" for i in range(width)]
        for nid in cur:
            s.add_node(GNode(nid, "company", nid))
            for p in prev:
                s.add_edge(GEdge(f"{nid}>{p}", nid, p, "ownership", pct=25))
        prev = cur
    for p in prev:
        s.add_node(GNode(f"owner-{p}", "person", "Owner"))
        s.add_edge(GEdge(f"o-{p}", f"owner-{p}", p, "ownership", pct=100))
    t0 = time.perf_counter()
    r = compute_ubo(s, "focus", max_depth=40)
    hits = downstream_reach(s, f"owner-{prev[0]}", {"focus"}, max_depth=40)
    assert time.perf_counter() - t0 < 10
    assert "depth_limit" in r.warnings and "focus" in hits
