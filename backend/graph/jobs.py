"""Job handlers of the graph app (registered in GraphConfig.ready)."""

from __future__ import annotations

from typing import Any


def register_all() -> None:
    from jobs import api as jobs

    from . import sync

    @jobs.register("graph.sync", max_attempts=5, timeout_s=120)
    def graph_sync(payload: dict[str, Any]) -> dict[str, Any]:
        applied = 0
        while True:
            n = sync.apply_pending(500)
            applied += n
            if n < 500:
                break
        return {"applied": applied}

    @jobs.register("graph.rebuild_org", max_attempts=2, timeout_s=600)
    def graph_rebuild(payload: dict[str, Any]) -> dict[str, Any]:
        return {"written": sync.rebuild_org(payload["orgId"])}
