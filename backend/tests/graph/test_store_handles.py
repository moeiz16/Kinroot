"""Single-writer handle management (ADR 0002): readers reopen when the sync version moves."""

from __future__ import annotations

import pytest
from django.test import override_settings

from graph import store as gs

pytestmark = pytest.mark.graph


def test_reader_reopens_on_version_change(tmp_path, settings):
    cfg = {
        **settings.KINROOT,
        "GRAPH_PATH": str(tmp_path / "h.lbug"),
        "GRAPH_WRITER": "worker",
        "GRAPH_BACKEND": "ladybug",
    }
    gs.reset()
    with override_settings(KINROOT=cfg):
        token = {"v": 1}
        r1 = gs.reader(lambda: token["v"])
        assert r1.read_only
        assert gs.reader(lambda: token["v"]) is r1
        token["v"] = 2
        r2 = gs.reader(lambda: token["v"])
        assert r2 is not r1
    gs.reset()


def test_inline_mode_reads_through_the_writer(tmp_path, settings):
    cfg = {**settings.KINROOT, "GRAPH_PATH": str(tmp_path / "i.lbug"), "GRAPH_WRITER": "inline"}
    gs.reset()
    with override_settings(KINROOT=cfg):
        assert gs.reader() is gs.writer()
        assert not gs.writer().read_only
    gs.reset()


def test_injected_store_wins(tmp_path):
    s = gs.LadybugStore(tmp_path / "x.lbug")
    gs.use_store(s)
    try:
        assert gs.reader() is s and gs.writer() is s
    finally:
        gs.use_store(None)
        s.close()
