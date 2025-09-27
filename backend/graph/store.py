"""Graph store adapters (ADR 0001, 0002).

`GraphStore` is the only object that talks to the graph engine. Queries are portable Cypher; only the schema DDL
differs per engine. Two implementations:

- `LadybugStore` (default): the embedded engine, one file under `data/graph/`. A process opens it either
  read-write (the single writer: the worker, or the current process with GRAPH_WRITER=inline) or read-only
  (the API with GRAPH_WRITER=worker), in which case the handle is reopened when the sync version moves.
- `Neo4jStore` (GRAPH_BACKEND=neo4j): the official driver against a Neo4j / AuraDB server.

Every edge stores `fromId`/`toId` as properties so results never depend on engine-internal node ids.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable, Iterable
from pathlib import Path
from typing import Any, Protocol

log = logging.getLogger(__name__)

SCHEMA_VERSION = 1

LADYBUG_DDL = [
    "CREATE NODE TABLE IF NOT EXISTS Party(id STRING, orgId STRING, kind STRING, name STRING, normName STRING, "
    "jurisdiction STRING, identifiers STRING, birthDate STRING, nationality STRING, isNominee BOOLEAN, "
    "dormant BOOLEAN, source STRING, sourceRef STRING, PRIMARY KEY(id))",
    "CREATE NODE TABLE IF NOT EXISTS Address(id STRING, orgId STRING, label STRING, postcode STRING, "
    "country STRING, PRIMARY KEY(id))",
    "CREATE REL TABLE IF NOT EXISTS OWNS(FROM Party TO Party, id STRING, orgId STRING, fromId STRING, toId STRING, "
    "pct DOUBLE, interest STRING, role STRING, nominee BOOLEAN, validFrom STRING, validTo STRING, source STRING, "
    "sourceRef STRING)",
    "CREATE REL TABLE IF NOT EXISTS CONTROLS(FROM Party TO Party, id STRING, orgId STRING, fromId STRING, "
    "toId STRING, pct DOUBLE, interest STRING, role STRING, nominee BOOLEAN, validFrom STRING, validTo STRING, "
    "source STRING, sourceRef STRING)",
    "CREATE REL TABLE IF NOT EXISTS REGISTERED_AT(FROM Party TO Address, id STRING, orgId STRING, fromId STRING, "
    "toId STRING)",
]

NEO4J_DDL = [
    "CREATE CONSTRAINT party_id IF NOT EXISTS FOR (n:Party) REQUIRE n.id IS UNIQUE",
    "CREATE CONSTRAINT address_id IF NOT EXISTS FOR (n:Address) REQUIRE n.id IS UNIQUE",
    "CREATE INDEX party_org IF NOT EXISTS FOR (n:Party) ON (n.orgId)",
    "CREATE INDEX owns_id IF NOT EXISTS FOR ()-[r:OWNS]-() ON (r.id)",
    "CREATE INDEX controls_id IF NOT EXISTS FOR ()-[r:CONTROLS]-() ON (r.id)",
]


class GraphStore(Protocol):
    backend: str
    read_only: bool

    def query(self, cypher: str, params: dict[str, Any] | None = None) -> list[dict[str, Any]]: ...

    def execute(self, cypher: str, params: dict[str, Any] | None = None) -> None: ...

    def ensure_schema(self) -> None: ...

    def close(self) -> None: ...


def normalise_element(item: Any) -> dict[str, Any]:
    """Path elements differ per engine (LadybugDB dicts with `_LABEL`/`_ID`, Kùzu `_label`, Neo4j objects).
    Return the plain property dict plus `_label` when the engine exposes it."""
    if isinstance(item, dict):
        props = {k: v for k, v in item.items() if not k.startswith("_")}
        label = item.get("_LABEL") or item.get("_label")
        if label:
            props["_label"] = label
        return props
    props = dict(item.items()) if hasattr(item, "items") else {}
    labels = getattr(item, "labels", None) or ([item.type] if hasattr(item, "type") else [])
    if labels:
        props["_label"] = next(iter(labels))
    return props


class LadybugStore:
    backend = "ladybug"

    def __init__(self, path: str | Path, *, read_only: bool = False) -> None:
        import ladybug

        self.path = str(path)
        self.read_only = read_only
        if not read_only:
            Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self._db = ladybug.Database(self.path, read_only=read_only)
        self._conn = ladybug.Connection(self._db)
        self._lock = threading.RLock()

    def query(self, cypher: str, params: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        with self._lock:
            res: Any = self._conn.execute(cypher, params or {})
            cols = res.get_column_names()
            out: list[dict[str, Any]] = []
            while res.has_next():
                out.append(dict(zip(cols, res.get_next(), strict=True)))
            return out

    def execute(self, cypher: str, params: dict[str, Any] | None = None) -> None:
        with self._lock:
            self._conn.execute(cypher, params or {})

    def ensure_schema(self) -> None:
        for stmt in LADYBUG_DDL:
            self.execute(stmt)

    def close(self) -> None:
        with self._lock:
            for obj in (self._conn, self._db):
                close = getattr(obj, "close", None)
                if close:
                    try:
                        close()
                    except Exception:  # pragma: no cover - engine shutdown noise
                        log.debug("graph close failed", exc_info=True)


class Neo4jStore:  # pragma: no cover - exercised only against a live server (optional adapter)
    backend = "neo4j"

    def __init__(self, uri: str, user: str, password: str, *, read_only: bool = False) -> None:
        try:
            import neo4j
        except ImportError as exc:
            raise RuntimeError('GRAPH_BACKEND=neo4j needs: pip install -e "backend[neo4j]"') from exc
        self.read_only = read_only
        self._driver = neo4j.GraphDatabase.driver(uri, auth=(user, password))
        self._access = neo4j.READ_ACCESS if read_only else neo4j.WRITE_ACCESS

    def query(self, cypher: str, params: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        with self._driver.session(default_access_mode=self._access) as session:
            return [rec.data() for rec in session.run(cypher, params or {})]

    def execute(self, cypher: str, params: dict[str, Any] | None = None) -> None:
        with self._driver.session(default_access_mode=self._access) as session:
            session.run(cypher, params or {}).consume()

    def ensure_schema(self) -> None:
        for stmt in NEO4J_DDL:
            self.execute(stmt)

    def close(self) -> None:
        self._driver.close()


# ── Process-wide handles ───────────────────────────────────────────────────────────────────────────
class _Handles:
    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.writer: GraphStore | None = None
        self.reader: GraphStore | None = None
        self.reader_token: Any = None
        self.override: GraphStore | None = None  # tests / eval inject a store


_handles = _Handles()


def _config() -> dict[str, Any]:
    from django.conf import settings

    return settings.KINROOT


def _open(read_only: bool) -> GraphStore:
    cfg = _config()
    if cfg.get("GRAPH_BACKEND") == "neo4j":
        store: GraphStore = Neo4jStore(
            cfg["NEO4J_URI"], cfg.get("NEO4J_USER", "neo4j"), cfg.get("NEO4J_PASSWORD", ""), read_only=read_only
        )
        if not read_only:
            store.ensure_schema()
        return store
    path = Path(cfg["GRAPH_PATH"])
    if read_only and not path.exists():
        # first start before the worker created the file: create the empty schema once, then reopen read-only
        bootstrap = LadybugStore(path, read_only=False)
        bootstrap.ensure_schema()
        bootstrap.close()
    store = LadybugStore(path, read_only=read_only)
    if not read_only:
        store.ensure_schema()
    return store


def writer() -> GraphStore:
    """The read-write handle. Only the single writer process calls this (worker, or inline mode)."""
    with _handles.lock:
        if _handles.override is not None:
            return _handles.override
        if _handles.writer is None:
            if _handles.reader is not None:
                _handles.reader.close()
                _handles.reader = None
            _handles.writer = _open(read_only=False)
        return _handles.writer


def reader(version_token: Callable[[], Any] | None = None) -> GraphStore:
    """A handle for queries. Inline mode (or a process that already writes) reuses the writer; otherwise a
    read-only handle that is reopened whenever `version_token()` changes (a read-only open sees a snapshot)."""
    with _handles.lock:
        if _handles.override is not None:
            return _handles.override
        if _handles.writer is not None or _config().get("GRAPH_WRITER", "worker") == "inline":
            return writer()
        token = version_token() if version_token else None
        if _handles.reader is None or token != _handles.reader_token:
            if _handles.reader is not None:
                _handles.reader.close()
            _handles.reader = _open(read_only=True)
            _handles.reader_token = token
        return _handles.reader


def use_store(store: GraphStore | None) -> None:
    """Inject a store (tests, eval). `None` restores normal handle management."""
    with _handles.lock:
        _handles.override = store


def reset() -> None:
    """Close every handle (tests, management commands that delete the graph file)."""
    with _handles.lock:
        for h in (_handles.writer, _handles.reader):
            if h is not None:
                h.close()
        _handles.writer = _handles.reader = None
        _handles.reader_token = None


def chunked(items: Iterable[Any], size: int = 500) -> Iterable[list[Any]]:
    batch: list[Any] = []
    for item in items:
        batch.append(item)
        if len(batch) >= size:
            yield batch
            batch = []
    if batch:
        yield batch
