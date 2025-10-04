# ADR 0001: Embedded property graph with Cypher (LadybugDB), portable to Neo4j

**Status:** accepted

## Context
Beneficial ownership is a graph problem: layered companies, trusts, nominees, cycles and "who controls this on
the onboarding date". The product must run on a laptop with no servers, no Docker and no Java, yet the
queries should move to a managed graph database in production without a rewrite.

Candidates: Neo4j (server, Java), FalkorDB (Redis module), NetworkX (in-memory, no query language), Kùzu
(embedded, Cypher; its upstream repository has been archived) and **LadybugDB** (the maintained fork of Kùzu).

## Decision
Use **LadybugDB** (`ladybug` on PyPI, pinned) as the embedded graph engine, behind a small `GraphStore` adapter
with a Neo4j implementation selected by `GRAPH_BACKEND=neo4j`.

Verified on Python 3.13, macOS arm64 with `scripts/graph_smoke.py` (both LadybugDB and Kùzu, separate processes):
node/edge creation with idempotent `MERGE`, variable-length ownership paths, point-in-time filtering, a 3-company
ownership cycle, undirected multi-type connection paths, control-role lookups and a two-date change diff all pass;
the BFS-plus-Python effective-ownership calculation agrees with the path query (49.6% / 30.4% on the test
structure). LadybugDB and Kùzu behaved identically; LadybugDB wins on maintenance. The two wheels cannot be imported
into one process (they register the same native types), so only LadybugDB is installed.

Portability rules learned from the smoke test (all queries must follow them):
1. Parameters cannot be used inside list predicates (`ALL`/`NONE`): bind them first with `WITH $asOf AS asOf`.
2. List comprehensions (`[x IN list | expr]`) are not supported: return `nodes(p)` / `relationships(p)` and
   normalise in Python (LadybugDB uses `_LABEL`/`_ID` keys, Kùzu `_label`/`_id`, Neo4j driver objects).
3. Variable-length matches use walk semantics here and trail semantics on Neo4j, and the session setting to
   change it had no effect. The app keeps **simple paths only** (no repeated node), which gives the same answer
   on both engines; cycles are detected separately.
4. Bounded depth everywhere (`*1..8`, `GRAPH_MAX_DEPTH`). Effective ownership uses hop-by-hop upstream fetches
   (`WHERE c.id IN $ids`), linear in edges and cycle-safe, then sums simple paths in Python.
5. Dates are ISO strings compared lexicographically; open-ended validity is `null` handled with
   `coalesce(r.validTo, '9999-12-31')`.
6. Shortest-path syntax differs between engines, so "connection" queries use bounded variable-length matches
   ordered by `length(p)`.

Schema: one node table `Party` (with `kind`, `orgId`) plus `Address`; relationship tables `OWNS` (pct, interest,
nominee, validFrom, validTo, id, source) and `CONTROLS` (role, …) and `REGISTERED_AT`. DDL is engine-specific;
queries are not.

## Consequences
- No server to run; the graph file lives in `data/graph/` and can always be rebuilt from Django (ADR 0002).
- Only one read-write process per database file; read-only handles can open alongside it (verified) and see a
  snapshot from open time. This shapes the single-writer design in ADR 0002.
- A young fork carries upgrade risk: the version is pinned and the smoke checks run in CI (`scripts/graph_smoke.py` and
  `tests/test_graph_engine.py`).
