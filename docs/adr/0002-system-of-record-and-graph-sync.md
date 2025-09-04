# ADR 0002: Django is the system of record; the graph is a synced projection

**Status:** accepted

## Context
CDD records must be durable, auditable, migratable and retained for 7 years. Relationship questions (paths,
cycles, clusters) are best answered by a graph engine. Keeping two stores raises consistency questions, and the
embedded engine allows only one read-write process (ADR 0001) while the API and the worker run as separate
processes.

## Decision
- **Django ORM tables are the truth**: `Party`, `Relationship` (with `valid_from`/`valid_to`), `Client`.
  Relationships are never deleted to record history; they are ended (`valid_to`), so the graph can answer
  "as at" questions. Deletion exists only for data-entry mistakes and is audited.
- **Transactional outbox**: `post_save`/`post_delete` signals on `Party` and `Relationship` write `GraphOutbox`
  rows inside the same transaction. Bulk loaders (seed, registry import) call `graph.api.rebuild_org` instead.
- **Single graph writer**: with `GRAPH_WRITER=worker` (default) only the job worker opens the graph read-write and
  drains the outbox in sequence order (`graph.sync`), then bumps `GraphSyncState.graph_version` and publishes a
  `graph.synced` event. The API opens the graph **read-only** and reopens when `graph_version` moves (about 20 ms).
  With `GRAPH_WRITER=inline` (tests, seed, single-process demo) the current process applies the outbox right
  after commit.
- Upserts are idempotent (`MERGE` on id), so replaying the outbox is safe; `rebuild_org` recreates an org's
  projection from scratch and is the recovery path.
- Every node carries `orgId`, and every query anchors on an org-scoped node and filters `orgId`.

## Consequences
- Reads can trail writes by up to one worker tick (about 1 s). Mutation responses return the new
  `graphVersion`; the web app waits for `graph.synced` (or polls `/graph/status`) before refetching the canvas.
- The graph can be deleted at any time and rebuilt; backups cover only the relational database.
- Moving to Neo4j changes the adapter, not the sync design; with a server, the API may also write directly.
