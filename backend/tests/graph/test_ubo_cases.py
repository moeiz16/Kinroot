"""UBO engine on crafted structures, run on the real embedded engine (shared with the eval harness)."""

from __future__ import annotations

import pytest

from graph.fixtures import check_case, load_cases, run_case

pytestmark = pytest.mark.graph
CASES = load_cases()


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_crafted_structure(store, case):
    org = f"t-{case['name']}"
    result, _ = run_case(store, org, case)
    assert check_case(result, case, org) == []


def test_every_case_has_expectations():
    assert len(CASES) >= 18
    assert all("expect" in c and "ubos" in c["expect"] for c in CASES)
