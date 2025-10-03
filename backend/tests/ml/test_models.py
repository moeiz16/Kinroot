"""Committed model artifacts: integrity, sensible scores, determinism, policy guard and the risk challenger."""

from __future__ import annotations

import json

import numpy as np
import pytest

from resolution import model as er
from resolution.features import compare
from resolution.ml.common import sha256
from risk import challenger as rc
from risk.features import ML_FEATURES


def test_er_manifest_files_match_hashes():
    man = er.manifest()
    for name, digest in man["files"].items():
        assert sha256(er.model_dir() / name) == digest, name
    assert man["champion"] in man["versions"]


def test_er_thresholds_are_ordered_probabilities():
    t = json.loads((er.model_dir() / "thresholds.json").read_text())
    assert 0 < t["review"] < t["auto_merge"] <= 1
    assert 0 <= t["expected_review_rate"] < 0.2


def test_er_scores_obvious_pairs():
    a = {
        "kind": "person",
        "name": "Ava Calder",
        "birth_date": "1972-04-09",
        "nationality": "AU",
        "address": {"line1": "1 George St", "postcode": "2000"},
    }
    same = er.score_features(compare(a, {**a, "name": "Ava  CALDER"}))
    other = er.score_features(
        compare(a, {"kind": "person", "name": "Liam Brown", "birth_date": "1990-01-01", "nationality": "GB"})
    )
    assert same["probability"] > 0.9 and same["band"] == "auto_merge"
    assert other["probability"] < 0.05 and other["band"] == "reject"


def test_conflicting_birth_dates_never_auto_merge():
    a = {"kind": "person", "name": "Imran Siddiqui", "birth_date": "1984-03-02"}
    s = er.score_features(compare(a, {**a, "name": "Imran Siddiqi", "birth_date": "1984-03-13"}))
    assert s["band"] != "auto_merge"
    assert er.conflicting_evidence({"dob_exact": 0, "dob_transposed": 0})
    assert not er.conflicting_evidence({"dob_exact": 0, "dob_transposed": 1})
    assert er.conflicting_evidence({"id_agree": 0})
    assert er.conflicting_evidence({"address_token_overlap": 0.1, "postcode_agree": 0})


def test_er_score_is_deterministic_and_monotone_in_name_similarity():
    base = {"kind": "person", "name": "Grace Whitlock", "birth_date": "1970-01-01"}
    f = compare(base, {**base, "name": "Grace Whitlock"})
    p1, p2 = er.score_features(f)["probability"], er.score_features(f)["probability"]
    assert p1 == p2
    lower = dict(f, name_jaro_winkler=0.7, name_token_set=0.6, surname_jaro_winkler=0.7)
    assert er.score_features(lower)["probability"] <= p1


def test_contributions_explain_the_raw_score():
    m = er.load()
    f = compare(
        {"kind": "person", "name": "Ava Calder"}, {"kind": "person", "name": "Ava Calder", "birth_date": "1972-04-09"}
    )
    x = np.array([f[k] for k in m.booster.feature_name()], float)
    contrib = m.contributions(x)
    raw_margin = m.booster.predict(x.reshape(1, -1), raw_score=True)[0]
    bias = m.booster.predict(x.reshape(1, -1), pred_contrib=True)[0][-1]
    assert abs(sum(contrib.values()) + bias - raw_margin) < 1e-6


def test_logreg_baseline_version_loads_and_scores():
    man = er.manifest()
    lr_version = next(v for v, s in man["versions"].items() if s["kind"] == "logreg")
    m = er.load(lr_version)
    ava = {
        "kind": "person",
        "name": "Ava Calder",
        "birth_date": "1972-04-09",
        "nationality": "AU",
        "address": {"line1": "1 George St", "postcode": "2000"},
    }
    same = er.score_features(compare(ava, dict(ava)), m)
    other = er.score_features(
        compare(ava, {"kind": "person", "name": "Liam Brown", "birth_date": "1990-01-01", "nationality": "GB"}), m
    )
    assert same["probability"] > 0.5 > other["probability"] and same["model_version"] == lr_version


def test_risk_manifest_and_policy():
    man = rc.manifest()
    assert man["features"] == list(ML_FEATURES)
    for name, digest in man["files"].items():
        assert sha256(rc.model_dir() / name) == digest, name
    policy = json.loads((rc.model_dir() / "policy.json").read_text())
    assert policy["rating_thresholds"]["medium"] < policy["rating_thresholds"]["high"]


def _client(**kw):
    f = dict.fromkeys(ML_FEATURES, 0.0)
    f.update(kind_company=1.0, n_services=1.0, n_ubos=1.0, n_layers_to_ubo=1.0)
    f.update(kw)
    return f


def test_challenger_ranks_risky_structure_above_plain_one():
    plain = rc.score(_client(), "low")
    risky = rc.score(
        _client(
            n_offshore_entities=2,
            nominee_indicators=2,
            max_officer_appointments=40,
            dormant_linked_companies=30,
            shared_officer_cluster_size=3,
        ),
        "low",
    )
    assert risky["probability_high"] > plain["probability_high"]
    assert risky["agreement"] == "disagree" and risky["rating"] == "high"
    assert len(risky["reasons"]) == 5 and risky["reasons"][0].direction == "for"


def test_challenger_is_deterministic():
    f = _client(n_offshore_entities=1)
    assert rc.score(f, "medium") == rc.score(f, "medium")


@pytest.mark.parametrize("rules", ["low", "medium", "high"])
def test_sanctions_confirmed_never_lowers_challenger_probability(rules):
    f = _client()
    assert (
        rc.score({**f, "sanctions_confirmed": 1.0}, rules)["probability_high"] >= rc.score(f, rules)["probability_high"]
    )
