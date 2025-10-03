from __future__ import annotations

import pytest

from .builder import World, harbour_quay


@pytest.fixture
def world(db):
    return World()


@pytest.fixture
def hq(db):
    return harbour_quay(World("Harbourline Test"))
