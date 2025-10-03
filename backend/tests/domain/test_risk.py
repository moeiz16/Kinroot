"""Risk: rules of record, stability, overrides, EDD triggers, the challenger, disagreements, registry."""

from __future__ import annotations

from datetime import date

import pytest

from clients.models import Client
from kinroot.contracts import DomainConflict, NotFound
from risk import api as risk
from risk import rules as R
from risk.features import ML_FEATURES, edd_triggers, inputs_hash
from risk.models import Disagreement, ModelPromotion, RiskAssessment, RiskMethodology

pytestmark = pytest.mark.django_db
M10 = R.default_methodologies()[0]


def feats(**kw):
    base = dict.fromkeys(ML_FEATURES, 0)
    base.update(kind_company=1, n_ubos=1, n_layers_to_ubo=1)
    base.update(kw)
    return base


# ── rules engine ──
def test_condition_dsl():
    f = {"a": 3, "b": 0, "c": "x"}
    assert R.evaluate({"feature": "a", "op": ">=", "value": 3}, f)
    assert R.evaluate({"all": [{"feature": "a", "op": ">", "value": 1}, {"not": {"feature": "b", "op": "truthy"}}]}, f)
    assert R.evaluate({"any": [{"feature": "b", "op": "truthy"}, {"feature": "c", "op": "in", "value": ["x"]}]}, f)
    assert not R.evaluate({"feature": "missing", "op": ">=", "value": 1}, f)


def test_plain_company_is_low_and_bands_apply():
    assert R.apply(M10, feats()).rating == "low"
    assert (
        R.rate(30, M10["bands"]) == "medium"
        and R.rate(59, M10["bands"]) == "medium"
        and R.rate(60, M10["bands"]) == "high"
    )


def test_floors_force_high():
    r = R.apply(M10, feats(kind_individual=1, kind_company=0, pep_client=1))
    assert r.rating == "high" and r.score < 60
    assert R.apply(M10, feats(sanctions_confirmed=1)).rating == "high"


def test_score_is_capped_at_100():
    r = R.apply(M10, feats(sanctions_confirmed=1, n_offshore_entities=3, has_cycle=1, nominee_indicators=3))
    assert r.score == 100 and r.raw_points > 100


MONOTONE = [
    "sanctions_possible",
    "sanctions_confirmed",
    "pep_in_structure",
    "has_cycle",
    "nominee_indicators",
    "n_offshore_entities",
    "n_high_risk_jurisdictions",
]


@pytest.mark.parametrize("flag", MONOTONE)
def test_adding_a_risk_factor_never_lowers_the_score(flag):
    for base in (feats(), feats(trust_in_chain=1, n_layers_to_ubo=3), feats(kind_individual=1, kind_company=0)):
        assert R.apply(M10, {**base, flag: 1}).score >= R.apply(M10, base).score


def test_identical_inputs_identical_hash_and_irrelevant_keys_ignored():
    f = feats(n_offshore_entities=1)
    assert inputs_hash(f, "KR-RM-1.0", "rc-1.0") == inputs_hash(dict(f), "KR-RM-1.0", "rc-1.0")
    assert inputs_hash(f, "KR-RM-1.0", "rc-1.0") != inputs_hash(f, "KR-RM-1.1", "rc-1.0")
    assert R.apply(M10, {**f, "client_name": "Anything"}).score == R.apply(M10, f).score


def test_edd_triggers_and_measures():
    codes = {t["code"]: t for t in edd_triggers(feats(pep_in_structure=1, n_layers_to_ubo=4, has_cycle=1), "high")}
    assert {"pep", "complex_structure", "circular_ownership", "high_rating"} <= set(codes)
    assert "senior_approval" in codes["pep"]["measures"]
    assert edd_triggers(feats(), "low") == []


# ── persisted assessments ──
def test_assess_client_persists_reasons_with_graph_evidence(hq):
    a = risk.assess_client(hq.org_id, hq.c["harbour-quay"].id, hq.actor("co"))
    assert a.rating == "high" and a.methodology_version == "KR-RM-1.0"
    offshore = next(r for r in a.reasons if r.code == "offshore_layer")
    assert any(e["type"] == "edge" and e["id"] == str(hq.r["kes>hq"].id) for e in offshore.evidence)
    assert a.challenger is not None and 0 <= a.challenger.probability_high <= 1 and len(a.challenger.reasons) == 5
    c = Client.objects.get(id=hq.c["harbour-quay"].id)
    assert c.rating == "high" and c.rating_source == "rules"


def test_reassessing_unchanged_client_is_idempotent(hq):
    a1 = risk.assess_client(hq.org_id, hq.c["harbour-quay"].id, hq.actor("co"))
    a2 = risk.assess_client(hq.org_id, hq.c["harbour-quay"].id, hq.actor("co"))
    assert a1.id == a2.id and a1.inputs_hash == a2.inputs_hash
    assert RiskAssessment.objects.filter(client=hq.c["harbour-quay"]).count() == 1


def test_structure_change_produces_new_assessment_and_history(world):
    world.person("p", "Plain Owner")
    world.company("c", "Plain Co Pty Ltd")
    world.own("p", "c", 100)
    world.client("c", "c")
    first = risk.assess_client(world.org_id, world.c["c"].id, world.actor("co"))
    world.company("ky", "Offshore Ltd", jurisdiction="KY")
    world.own("ky", "c", 50, since="2019-01-01", key="ky")
    world.refresh_structure()
    second = risk.assess_client(world.org_id, world.c["c"].id, world.actor("co"))
    assert second.id != first.id and second.score > first.score
    assert [a.id for a in risk.assessment_history(world.org_id, world.c["c"].id)] == [second.id, first.id]


def test_override_rules(hq):
    a = risk.assess_client(hq.org_id, hq.c["harbour-quay"].id, hq.actor("co"))
    with pytest.raises(ValueError):
        risk.override_rating(hq.org_id, hq.c["harbour-quay"].id, "low", "too short", hq.actor("co"))
    o = risk.override_rating(
        hq.org_id, hq.c["harbour-quay"].id, "medium", "Offshore holding verified with audited accounts", hq.actor("co")
    )
    assert o.override["rating"] == "medium" and o.rating == a.rating
    c = Client.objects.get(id=hq.c["harbour-quay"].id)
    assert c.rating == "medium" and c.rating_source == "override"
    assert all(t.code != "high_rating" for t in risk.edd_requirements(hq.org_id, hq.c["harbour-quay"].id))


def test_disagreement_queue_and_resolution(hq):
    a = risk.assess_client(hq.org_id, hq.c["harbour-quay"].id, hq.actor("co"))
    rr = RiskAssessment.objects.get(id=a.id)
    d = Disagreement.objects.create(
        org=hq.org,
        client=hq.c["harbour-quay"],
        assessment=rr,
        rules_rating="high",
        challenger_rating="low",
        probability_high=0.05,
    )
    page = risk.list_disagreements(hq.org_id)
    assert page.total == 1 and page.items[0]["clientName"] == "Harbour Quay Developments Pty Ltd"
    out = risk.resolve_disagreement(
        hq.org_id, d.id, "keep_rules", "Offshore layer confirmed as genuine", hq.actor("co")
    )
    assert out["status"] == "resolved" and out["outcome"] == "keep_rules"
    with pytest.raises(DomainConflict):
        risk.resolve_disagreement(hq.org_id, d.id, "keep_rules", "again", hq.actor("co"))


def test_methodology_seed_and_publish(world):
    versions = risk.methodology_versions(world.org_id)
    assert [v["version"] for v in versions] == ["KR-RM-1.1", "KR-RM-1.0"]
    assert [v["status"] for v in versions] == ["draft", "published"]
    draft = next(v for v in versions if v["status"] == "draft")
    out = risk.publish_methodology(world.org_id, draft["id"], world.actor("co"))
    assert out["status"] == "published"
    assert RiskMethodology.objects.get(org=world.org, version="KR-RM-1.0").status == "retired"
    with pytest.raises(DomainConflict):
        risk.publish_methodology(world.org_id, draft["id"], world.actor("co"))


def test_model_registry_and_promotion(world):
    reg = {m["name"]: m for m in risk.model_registry()}
    assert set(reg) == {"er-matcher", "risk-challenger"}
    rc = reg["risk-challenger"]["versions"]
    assert (
        rc[0]["stage"] == "champion"
        and rc[0]["calibration"]["brier"] is not None
        and "Model card" in rc[0]["modelCard"]
    )
    challenger = next(v["version"] for v in rc if v["stage"] == "challenger")
    with pytest.raises(ValueError):
        risk.promote_model("risk-challenger", challenger, world.actor("co"), "short")
    out = risk.promote_model("risk-challenger", challenger, world.actor("co"), "Simpler model preferred after review")
    assert next(v for v in out["versions"] if v["version"] == challenger)["stage"] == "champion"
    assert ModelPromotion.objects.filter(model_name="risk-challenger").count() == 1
    with pytest.raises(NotFound):
        risk.promote_model("nope", "1", world.actor("co"), "whatever text")


def test_unknown_client_is_not_found(world):
    import uuid

    with pytest.raises(NotFound):
        risk.assess_client(world.org_id, uuid.uuid4(), world.actor("co"))
    assert risk.edd_requirements(world.org_id, world.client("x", world.person("x", "X Person").name and "x").id) == []


def test_drift_needs_enough_assessments():
    d = risk.model_drift()
    assert d["status"] == "stable" and d["n"] < 50


def test_individual_pep_rating_floor_does_not_open_disagreement(world):
    from screening import api as screening

    world.person("jw", "Hon. Julian Whitfield", birth_date=date(1961, 8, 3), nationality="AU", jurisdiction="AU")
    world.client("jw", "jw")
    screening.screen_client(world.org_id, world.c["jw"].id, world.actor("co"))
    from screening.models import ScreeningHit

    h = ScreeningHit.objects.get(org=world.org)
    screening.review_hit(world.org_id, h.id, "true_match", "Confirmed member of parliament", world.actor("co"))
    a = risk.latest_assessment(world.org_id, world.c["jw"].id)
    assert a.rating == "high" and a.challenger.agreement == "agree"
    assert not Disagreement.objects.filter(org=world.org).exists()
