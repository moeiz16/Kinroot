"""Shared ML utilities (calibration, thresholds, drift) and plain-language reasons."""

from __future__ import annotations

import numpy as np

from resolution.ml.common import Isotonic, ece, precision_threshold, psi, psi_status, quantile_edges, recall_threshold
from resolution.reasons import reasons


def test_ece_zero_for_perfectly_calibrated_bins():
    y = np.array([0] * 50 + [1] * 50)
    p = np.array([0.0] * 50 + [1.0] * 50)
    assert ece(y, p) == 0.0
    assert ece(y, np.full(100, 0.5)) == 0.0


def test_precision_threshold_finds_pure_region():
    p = np.linspace(0, 1, 200)
    y = (p > 0.7).astype(int)
    t = precision_threshold(y, p, 0.99)
    assert 0.69 < t < 0.72


def test_recall_threshold_keeps_target_positives():
    p = np.linspace(0, 1, 100)
    y = np.ones(100, int)
    t = recall_threshold(y, p, 0.9)
    assert (p >= t).mean() >= 0.9


def test_isotonic_is_monotone_and_roundtrips():
    rng = np.random.default_rng(0)
    raw = rng.random(500)
    y = (rng.random(500) < raw).astype(int)
    cal = Isotonic().fit(raw, y)
    out = cal(np.sort(raw))
    assert np.all(np.diff(out) >= -1e-12)
    again = Isotonic.from_dict(cal.to_dict())
    assert np.allclose(again(raw), cal(raw))


def test_psi_detects_shift():
    rng = np.random.default_rng(1)
    ref = rng.normal(0, 1, 2000)
    edges = quantile_edges(ref)
    assert psi(ref, rng.normal(0, 1, 2000), edges) < 0.1
    assert psi(ref, rng.normal(1.5, 1, 2000), edges) > 0.25
    assert psi_status(0.05) == "stable" and psi_status(0.2) == "watch" and psi_status(0.4) == "drift"


def test_reasons_are_plain_language_and_ranked():
    feats = {"dob_exact": 1.0, "id_agree": 0.0, "name_jaro_winkler": 0.97}
    out = reasons(feats, {"dob_exact": 2.0, "id_agree": -3.0, "name_jaro_winkler": 0.5})
    assert [r.label for r in out] == ["Different company numbers", "Same date of birth", "Names are almost identical"]
    assert out[0].direction == "against" and out[1].direction == "for"
