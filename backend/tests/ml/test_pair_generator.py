"""Labelled pair generation: entity-level folds (no leakage), both labels, high blocking recall."""

from __future__ import annotations

import pytest

from resolution.ml.data import PairGenerator, abn_from_acn, acn_with_check
from resolution.normalize import abn_valid, acn_valid


@pytest.fixture(scope="module")
def generated():
    gen = PairGenerator(seed=7, use_register=False, scale=0.05)
    df, stats = gen.build_pairs()
    return gen, df, stats


def test_no_entity_spans_two_folds(generated):
    gen, _df, _ = generated
    folds: dict[str, set[str]] = {}
    for e in gen.entities:
        folds.setdefault(e.eid.split("-")[0], set()).add(e.split)
    assert all(len(v) == 1 for v in folds.values())


def test_pairs_have_both_labels_and_hard_negatives(generated):
    _gen, df, _ = generated
    assert set(df.label) == {0, 1}
    assert df.hard_negative.sum() > 0
    assert (df[df.hard_negative == 1].label == 0).all()


def test_blocking_recall_is_high(generated):
    _gen, _df, stats = generated
    assert all(f["blocking_recall"] is None or f["blocking_recall"] >= 0.9 for f in stats["folds"].values())


def test_same_seed_same_pairs():
    a, _ = PairGenerator(seed=3, use_register=False, scale=0.02).build_pairs()
    b, _ = PairGenerator(seed=3, use_register=False, scale=0.02).build_pairs()
    assert a.equals(b)


def test_synthetic_company_numbers_are_valid():
    import random

    rng = random.Random(1)
    for _ in range(20):
        acn = acn_with_check(rng)
        assert acn_valid(acn) and abn_valid(abn_from_acn(acn))
