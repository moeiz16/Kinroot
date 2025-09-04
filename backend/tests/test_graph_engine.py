"""ADR 0001 guard: the embedded engine runs the portable Cypher patterns the graph app depends on."""

from __future__ import annotations

import pytest

ladybug = pytest.importorskip("ladybug")
pytestmark = pytest.mark.graph


def _rows(conn, query, params=None):
    res = conn.execute(query, params or {})
    out = []
    while res.has_next():
        out.append(res.get_next())
    return out


@pytest.fixture
def conn(tmp_path):
    db = ladybug.Database(str(tmp_path / "g.lbug"))
    c = ladybug.Connection(db)
    c.execute("CREATE NODE TABLE Party(id STRING, kind STRING, PRIMARY KEY(id))")
    c.execute("CREATE REL TABLE OWNS(FROM Party TO Party, id STRING, pct DOUBLE, validFrom STRING, validTo STRING)")
    for pid, kind in [("p", "person"), ("a", "company"), ("b", "company"), ("c", "company")]:
        c.execute("MERGE (n:Party {id: $id}) ON CREATE SET n.kind = $k", {"id": pid, "k": kind})
    for eid, s, t, pct in [
        ("1", "p", "a", 50.0),
        ("2", "a", "b", 60.0),
        ("3", "b", "c", 70.0),
        ("4", "c", "a", 40.0),
    ]:
        c.execute(
            "MATCH (s:Party {id: $s}), (t:Party {id: $t}) MERGE (s)-[r:OWNS {id: $id}]->(t) "
            "SET r.pct = $pct, r.validFrom = '2020-01-01'",
            {"s": s, "t": t, "id": eid, "pct": pct},
        )
    return c


def test_variable_length_with_bound_parameter(conn):
    rows = _rows(
        conn,
        "WITH $asOf AS asOf MATCH p = (o:Party {kind: 'person'})-[:OWNS*1..6]->(t:Party {id: 'c'}) "
        "WHERE ALL(r IN relationships(p) WHERE r.validFrom <= asOf) RETURN nodes(p), relationships(p)",
        {"asOf": "2021-01-01"},
    )
    simple = [r for r in rows if len({n["id"] for n in r[0]}) == len(r[0])]
    assert [[e["id"] for e in r[1]] for r in simple] == [["1", "2", "3"]]


def test_cycle_detected_and_bounded(conn):
    rows = _rows(conn, "MATCH p = (x:Party)-[:OWNS*2..6]->(x) RETURN x.id, nodes(p)")
    simple = {r[0] for r in rows if len({n["id"] for n in r[1][:-1]}) == len(r[1]) - 1}
    assert simple == {"a", "b", "c"}
