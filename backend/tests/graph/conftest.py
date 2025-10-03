from __future__ import annotations

import pytest

from graph.store import LadybugStore


@pytest.fixture
def store(tmp_path):
    s = LadybugStore(tmp_path / "graph.lbug")
    s.ensure_schema()
    yield s
    s.close()
