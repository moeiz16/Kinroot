"""Kinroot evaluation harness: `make eval` (runs from backend/).

Evaluates the committed artifacts and the domain engines on held-out and crafted data, writes
eval/RESULTS.md (no run timestamps) and eval/results.json, and exits non-zero when any gate in eval/gates.json
fails, so CI blocks a regression.

Sections: entity resolution (Fellegi-Sunter vs logistic vs LightGBM, review-queue rate), UBO correctness on
crafted structures, screening precision on labelled near-misses, the risk challenger (AUC, calibration,
agreement with the rules), risk-score stability, and assistant citation correctness.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from datetime import date
from pathlib import Path
from typing import Any

EVAL_DIR = Path(__file__).resolve().parent
REPO = EVAL_DIR.parent
BACKEND = REPO / "backend"
FIXTURES = EVAL_DIR / "fixtures"
sys.path.insert(0, str(BACKEND))
_tmp = tempfile.mkdtemp(prefix="kinroot-eval-")
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "kinroot.settings")
os.environ["DJANGO_ENV"] = "test"
os.environ["DATABASE_URL"] = "sqlite:///:memory:"
os.environ["GRAPH_WRITER"] = "inline"
os.environ["GRAPH_PATH"] = str(Path(_tmp) / "graph.lbug")
os.environ["LLM_FAKE"] = "true"
os.environ["MLFLOW_DISABLE_AGENT_HINT"] = "1"
os.environ["LOG_LEVEL"] = "WARNING"

import django  # noqa: E402

django.setup()

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from resolution.ml.common import binary_metrics, r4  # noqa: E402


# ── 1. Entity resolution ──────────────────────────────────────────────────────────────────────────
def eval_er() -> dict[str, Any]:
    from resolution import model as er
    from resolution.features import FEATURES
    from resolution.model import conflicting_evidence

    df = pd.read_csv(FIXTURES / "er_test_pairs.csv.gz")
    X, y = df[list(FEATURES)].to_numpy(float), df.label.to_numpy()
    rows = df[list(FEATURES)].to_dict("records")
    man = er.manifest()
    metrics_file = json.loads((er.model_dir() / "metrics.json").read_text())
    champion = er.load(man["champion"])
    lr_version = next(v for v, s in man["versions"].items() if s["kind"] == "logreg")
    lr = er.load(lr_version)
    conflict = np.array([conflicting_evidence(r) for r in rows], bool)

    def operating(m: Any, p: np.ndarray) -> dict[str, float]:
        t = m.thresholds
        auto = (p >= t["auto_merge"]) & ~conflict
        review = (p >= t["review"]) & ~auto
        return {
            "auto_merge_precision": r4(y[auto].mean()) if auto.any() else 1.0,
            "false_merges": int((auto & (y == 0)).sum()),
            "review_rate": r4(review.mean()),
            "recall_at_review": r4(((p >= t["review"]) & (y == 1)).sum() / max(1, (y == 1).sum())),
            "auto_merge_share_of_matches": r4((auto & (y == 1)).sum() / max(1, (y == 1).sum())),
        }

    fs_p = champion.fs.probabilities(rows)
    p_lr, p_gb = lr.probability(X), champion.probability(X)
    out = {
        "test_pairs": len(df),
        "matches": int(y.sum()),
        "blocking_recall": metrics_file["data"]["folds"]["test"]["blocking_recall"],
        "fellegi_sunter": binary_metrics(y, fs_p, metrics_file["fs_threshold"]),
        "logistic_regression": {**binary_metrics(y, p_lr, 0.5), **operating(lr, p_lr)},
        "random_forest": metrics_file["metrics_test"]["random_forest"],
        "lightgbm": {**binary_metrics(y, p_gb, 0.5), **operating(champion, p_gb)},
        "thresholds": {k: champion.thresholds[k] for k in ("auto_merge", "review", "expected_review_rate")},
        "model_version": champion.version,
    }
    fair = {}
    people = df[df.kind == "person"]
    for origin, grp in people.groupby("origin"):
        idx = grp.index.to_numpy()
        if (y[idx] == 1).sum() < 15:
            continue
        fair[str(origin)] = r4(
            ((p_gb[idx] >= champion.thresholds["review"]) & (y[idx] == 1)).sum() / (y[idx] == 1).sum()
        )
    out["recall_at_review_by_name_origin"] = fair
    out["recall_gap_across_origins"] = r4(max(fair.values()) - min(fair.values())) if fair else 0.0
    return out


# ── 2. UBO correctness ────────────────────────────────────────────────────────────────────────────
def eval_ubo() -> dict[str, Any]:
    from graph.fixtures import check_case, load_cases, run_case
    from graph.store import LadybugStore

    store = LadybugStore(Path(_tmp) / "ubo.lbug")
    store.ensure_schema()
    results = []
    for i, case in enumerate(load_cases()):
        org = f"eval-{i}"
        res, _ = run_case(store, org, case)
        problems = check_case(res, case, org)
        results.append({"case": case["name"], "ok": not problems, "problems": problems})
    store.close()
    ok = sum(r["ok"] for r in results)
    return {
        "cases": len(results),
        "correct": ok,
        "accuracy": r4(ok / len(results)),
        "failures": [r for r in results if not r["ok"]],
        "covers": sorted({c["name"].split("_")[0] for c in load_cases()}),
    }


# ── 3. Screening precision ────────────────────────────────────────────────────────────────────────
def eval_screening() -> dict[str, Any]:
    from screening.matcher import Entry, ListIndex, screen
    from screening.service import _bundled_rows

    data = json.loads((FIXTURES / "screening_cases.json").read_text())
    _, rows = _bundled_rows()
    idx = ListIndex(
        [
            Entry(
                r["entry_id"],
                r["list_kind"],
                r["schema"],
                r["name"],
                r["aliases"],
                r["birth_date"],
                r["countries"],
                r["programs"],
            )
            for k in rows
            for r in rows[k]
        ]
    )
    tp = fp = fn = tn = 0
    misses: list[str] = []
    for case in data["cases"]:
        hits = screen(idx, case["record"], threshold=data["threshold"])
        ids = [e.id for e, _, _ in hits]
        if case["expect"]:
            if case["expect"] in ids:
                tp += 1
                fp += len([i for i in ids if i != case["expect"]])
            else:
                fn += 1
                misses.append(f"missed: {case['note']}")
        else:
            if ids:
                fp += len(ids)
                misses.append(f"false alert: {case['note']} -> {ids}")
            else:
                tn += 1
    precision = tp / max(1, tp + fp)
    recall = tp / max(1, tp + fn)
    return {
        "cases": len(data["cases"]),
        "threshold": data["threshold"],
        "true_alerts": tp,
        "false_alerts": fp,
        "missed": fn,
        "correctly_silent": tn,
        "precision": r4(precision),
        "recall": r4(recall),
        "notes": misses,
    }


# ── 4 + 5. Risk challenger and stability ─────────────────────────────────────────────────────────
def eval_risk() -> dict[str, Any]:
    from risk import challenger as rc
    from risk import rules as R
    from risk.features import ML_FEATURES
    from risk.ml.train import RATING, challenger_rating, disagrees, rules_scores
    from sklearn.metrics import average_precision_score, roc_auc_score

    df = pd.read_csv(FIXTURES / "risk_test_clients.csv.gz")
    y = df.label.to_numpy()
    X = df[list(ML_FEATURES)].to_numpy(float)
    man = rc.manifest()
    champ = rc.load(man["champion"])
    lr = rc.load(next(v for v, s in man["versions"].items() if s["kind"] == "logreg"))
    p = np.array([champ.probability(x) for x in X])
    p_lr = np.array([lr.probability(x) for x in X])
    methodology = R.default_methodologies()[0]
    rs, rr = rules_scores(df, methodology)
    thr, margin = champ.policy["rating_thresholds"], float(champ.policy["disagreement_margin"])
    ch = challenger_rating(p, thr)
    dis = np.array([disagrees(int(a), float(b), thr, margin) for a, b in zip(rr, p, strict=True)])
    up = dis & (ch > rr)
    out: dict[str, Any] = {
        "clients": len(df),
        "base_rate": r4(y.mean()),
        "rules_scorecard": {
            "roc_auc": r4(roc_auc_score(y, rs)),
            "average_precision": r4(average_precision_score(y, rs)),
        },
        "logistic_regression": binary_metrics(y, p_lr, thr["high"]),
        "lightgbm": binary_metrics(y, p, thr["high"]),
        "agreement_with_rules": r4(np.mean(ch == rr)),
        "disagreement_rate": r4(dis.mean()),
        "outcome_rate_where_challenger_higher": r4(y[up].mean()) if up.any() else None,
        "model_version": champ.version,
    }
    # fairness (protected attributes are not features)
    flags = ch == RATING["high"]
    groups = {
        g: r4(flags[(df.nationality_group == g).to_numpy()].mean()) for g in sorted(df.nationality_group.unique())
    }
    out["high_flag_rate_by_nationality_group"] = groups
    out["flag_rate_ratio"] = r4(min(groups.values()) / max(groups.values())) if max(groups.values()) > 0 else 1.0

    # stability of the rules of record
    monotone = [
        "sanctions_possible",
        "sanctions_confirmed",
        "pep_in_structure",
        "has_cycle",
        "nominee_indicators",
        "n_offshore_entities",
        "n_high_risk_jurisdictions",
        "recent_ownership_changes_12m",
        "channel_remote",
        "foreign_client",
    ]
    sample = df[list(ML_FEATURES)].head(800).to_dict("records")
    violations = 0
    for f in sample:
        base = R.apply(methodology, f).score
        for k in monotone:
            if R.apply(methodology, {**f, k: f[k] + 1}).score < base:
                violations += 1
    repeat = all(R.apply(methodology, f).score == R.apply(methodology, dict(f)).score for f in sample[:200])
    irrelevant = all(
        R.apply(methodology, {**f, "client_name": "x", "matter_reference": "y"}).score == R.apply(methodology, f).score
        for f in sample[:200]
    )
    j = list(ML_FEATURES).index("n_services")
    Xp = X.copy()
    Xp[:, j] = Xp[:, j] + 1
    pp = np.array([champ.probability(x) for x in Xp])
    out["stability"] = {
        "rules_monotonicity_checks": len(sample) * len(monotone),
        "rules_monotonicity_violations": violations,
        "rules_identical_inputs_identical_score": repeat,
        "rules_ignore_irrelevant_fields": irrelevant,
        "challenger_mean_abs_change_irrelevant": r4(np.mean(np.abs(pp - p))),
        "challenger_rating_flip_rate_irrelevant": r4(np.mean(challenger_rating(pp, thr) != ch)),
        "challenger_repeat_identical": bool(np.array_equal(p, np.array([champ.probability(x) for x in X]))),
    }
    return out


# ── 6. Assistant citation correctness ─────────────────────────────────────────────────────────────
def eval_assistant() -> dict[str, Any]:
    import uuid

    from django.core.management import call_command

    call_command("migrate", verbosity=0)
    from accounts.models import Organisation
    from assistant import api as assistant
    from clients.models import Client, Party, Relationship
    from kinroot.contracts import Actor

    org = Organisation.objects.create(name="Eval Firm", slug=f"eval-{uuid.uuid4().hex[:6]}", country="AU")
    P: dict[str, Any] = {}

    def party(key: str, kind: str, name: str, **kw: Any) -> None:
        P[key] = Party.objects.create(org=org, kind=kind, name=name, **kw)

    def rel(
        key: str, a: str, b: str, kind: str, pct: float | None = None, role: str = "", since: str = "2019-01-01"
    ) -> Any:
        r = Relationship.objects.create(
            org=org, from_party=P[a], to_party=P[b], kind=kind, pct=pct, role=role, valid_from=date.fromisoformat(since)
        )
        P[f"r:{key}"] = r
        return r

    party("ava", "person", "Ava Calder")
    party("ben", "person", "Ben Okafor")
    party("trust", "trust", "Calder Family Trust", jurisdiction="AU")
    party("bell", "company", "Bellmere Holdings Pty Ltd", jurisdiction="AU")
    party("kes", "company", "Kestrel Ventures Ltd", jurisdiction="VG")
    party("hq", "company", "Harbour Quay Developments Pty Ltd", jurisdiction="AU")
    party("pell", "person", "Gregory Pell", is_nominee=True)
    party("tr", "company", "Tasman Ridge Pty Ltd", jurisdiction="AU")
    party("ol", "company", "Orchard Lane Investments Pty Ltd", jurisdiction="AU")
    party("marcus", "person", "Marcus Hale")
    rel("o1", "ava", "trust", "ownership", 100)
    rel("o2", "trust", "bell", "ownership", 62)
    rel("o3", "ben", "bell", "ownership", 38)
    rel("o4", "bell", "kes", "ownership", 80, since="2020-03-01")
    rel("o5", "kes", "hq", "ownership", 100, since="2021-02-01")
    rel("c1", "pell", "kes", "control", role="director")
    rel("t1", "marcus", "tr", "ownership", 50)
    rel("t2", "tr", "ol", "ownership", 60)
    rel("t3", "ol", "tr", "ownership", 40)
    client = Client.objects.create(
        org=org,
        kind="company",
        name="Harbour Quay Developments Pty Ltd",
        party=P["hq"],
        status="active",
        onboarded_on=date(2022, 1, 1),
    )
    Client.objects.create(
        org=org,
        kind="company",
        name="Tasman Ridge Pty Ltd",
        party=P["tr"],
        status="active",
        onboarded_on=date(2022, 1, 1),
    )
    from clients import services

    services.rebuild_structure(org.id)
    actor = Actor(org_id=org.id, user_id=None, name="Eval")
    perms = frozenset({"assistant:use", "graph:read", "screening:read", "risk:read"})
    e = lambda k: str(P[f"r:{k}"].id)  # noqa: E731
    questions = [
        ("Who controls Harbour Quay Developments?", {e("o1"), e("o2"), e("o4"), e("o5")}, True),
        ("Who are the beneficial owners of Bellmere Holdings?", {e("o1"), e("o2"), e("o3")}, True),
        ("How is Ben Okafor connected to Gregory Pell?", {e("o3"), e("o4"), e("c1")}, True),
        ("What changed in Harbour Quay Developments since 2020-06-01?", {e("o5")}, True),
        ("Who owns Tasman Ridge?", {e("t1"), e("t2"), e("t3")}, True),
        ("How is Ava Calder linked to Kestrel Ventures?", {e("o1"), e("o2"), e("o4")}, True),
        ("What is the capital of France?", set(), False),
        ("Tell me about the suspicious matter report", set(), False),
    ]
    rows = []
    for q, expected, answerable in questions:
        a = assistant.ask(org.id, q, actor, permissions=perms, client_id=client.id if "this client" in q else None)
        cited = {c.id for c in a.citations if c.type == "edge"}
        if answerable:
            ok = a.grounded and expected <= cited
        else:
            ok = not a.grounded and not a.citations
        rows.append({"question": q, "ok": ok, "grounded": a.grounded, "missing": sorted(expected - cited)})
    ok = sum(r["ok"] for r in rows)
    return {
        "questions": len(rows),
        "correct": ok,
        "citation_accuracy": r4(ok / len(rows)),
        "failures": [r for r in rows if not r["ok"]],
    }


# ── Report ────────────────────────────────────────────────────────────────────────────────────────
def lookup(results: dict[str, Any], path: str) -> Any:
    cur: Any = results
    for part in path.split("."):
        cur = cur[part]
    return cur


def check_gates(results: dict[str, Any]) -> list[dict[str, Any]]:
    gates = json.loads((EVAL_DIR / "gates.json").read_text())["gates"]
    out = []
    for g in gates:
        value = lookup(results, g["metric"])
        ref = g.get("value")
        if "relative_to" in g:
            ref = lookup(results, g["relative_to"]) + g.get("margin", 0.0)
        ok = value >= ref if g["op"] == ">=" else (value <= ref if g["op"] == "<=" else value == ref)
        out.append({**g, "actual": value, "threshold": r4(ref) if isinstance(ref, float) else ref, "passed": bool(ok)})
    return out


def fmt(v: Any) -> str:
    if v is None:
        return "-"
    if isinstance(v, float):
        return f"{v:.4f}".rstrip("0").rstrip(".") if v != int(v) else f"{v:.1f}"
    return str(v)


def render(r: dict[str, Any], gates: list[dict[str, Any]]) -> str:
    er, ubo, sc, rk, asst = r["er"], r["ubo"], r["screening"], r["risk"], r["assistant"]

    def er_row(name: str, m: dict[str, Any]) -> str:
        return (
            f"| {name} | {fmt(m.get('precision'))} | {fmt(m.get('recall'))} | {fmt(m.get('f1'))} | {fmt(m.get('average_precision'))} | "
            f"{fmt(m.get('brier'))} | {fmt(m.get('ece'))} | {fmt(m.get('review_rate'))} |"
        )

    def rk_row(name: str, m: dict[str, Any]) -> str:
        return f"| {name} | {fmt(m.get('roc_auc'))} | {fmt(m.get('average_precision'))} | {fmt(m.get('brier'))} | {fmt(m.get('ece'))} |"

    gate_rows = "\n".join(
        f"| `{g['metric']}` | {g['op']} {fmt(g['threshold'])} | {fmt(g['actual'])} | {'pass' if g['passed'] else '**FAIL**'} |"
        for g in gates
    )
    fair = ", ".join(f"{k} {fmt(v)}" for k, v in er["recall_at_review_by_name_origin"].items())
    st = rk["stability"]
    return f"""# Kinroot evaluation results

Generated by `make eval` (`eval/run.py`) from the committed models in `backend/artifacts/models/` and the held-out
fixtures in `eval/fixtures/`. Every number below is reproducible from the repository; CI fails when a gate fails.

## Gates
| Metric | Gate | Actual | Status |
|---|---|---|---|
{gate_rows}

## 1. Entity resolution (held-out test fold, {er["test_pairs"]} blocked pairs, {er["matches"]} true matches)
Pairs come from the production blocking (blocking recall on the fold: {fmt(er["blocking_recall"])}). Split by entity,
so no person or company appears in both training and test.

| Model | Precision | Recall | F1 | Avg precision | Brier | ECE | Review-queue rate |
|---|---|---|---|---|---|---|---|
{er_row("Fellegi-Sunter (EM, unsupervised)", er["fellegi_sunter"])}
{er_row("Logistic regression (calibrated)", er["logistic_regression"])}
{er_row("Random forest", er["random_forest"])}
{er_row("LightGBM (calibrated, champion)", er["lightgbm"])}

Operating point of the champion (`{er["model_version"]}`): auto-merge at p ≥ {fmt(er["thresholds"]["auto_merge"])}
(and no conflicting birth date, number or address), review from p ≥ {fmt(er["thresholds"]["review"])}.
Auto-merge precision **{fmt(er["lightgbm"]["auto_merge_precision"])}** ({er["lightgbm"]["false_merges"]} false merges),
{fmt(er["lightgbm"]["auto_merge_share_of_matches"])} of true matches merged without a human, recall at the review
threshold {fmt(er["lightgbm"]["recall_at_review"])}, review-queue rate **{fmt(er["lightgbm"]["review_rate"])}**.
Recall at review by name origin: {fair} (gap {fmt(er["recall_gap_across_origins"])}).

## 2. Beneficial ownership on crafted structures
{ubo["correct"]} of {ubo["cases"]} structures correct (accuracy {fmt(ubo["accuracy"])}): trusts over companies over
offshore holdings, three-company cycles, a person entering a cycle, mutual cross-holdings, diamond paths that only
cross the threshold together, undisclosed bearer holders, nominees with disclosed principals, a company limited by
guarantee (senior managing official), point-in-time before and after an ownership change, unit trusts, over-allocated
registers, corporate trustees, six-layer chains and the depth limit. Each case checks every owner's effective %,
UBO status, control, unexplained %, cycles and warnings on the real embedded graph engine.

## 3. Screening on labelled near-misses
{sc["cases"]} labelled cases against the bundled fictional lists at the default threshold {fmt(sc["threshold"])}:
precision **{fmt(sc["precision"])}**, recall **{fmt(sc["recall"])}** ({sc["true_alerts"]} true alerts, {sc["false_alerts"]} false
alerts, {sc["missed"]} missed, {sc["correctly_silent"]} correctly silent). Hard cases include transliterations, aliases,
initials, reordered names, legal-form changes, namesakes with a different full date of birth, shared surnames,
gendered surname variants and company names that share only generic words.
{chr(10).join("- " + n for n in sc["notes"]) if sc["notes"] else ""}

## 4. Risk challenger (latest onboarding cohort, {rk["clients"]} synthetic clients, outcome rate {fmt(rk["base_rate"])})
| Model | ROC-AUC | Avg precision | Brier | ECE |
|---|---|---|---|---|
{rk_row("Rules methodology score (decision of record)", rk["rules_scorecard"])}
{rk_row("Logistic regression", rk["logistic_regression"])}
{rk_row("LightGBM (calibrated, `" + rk["model_version"] + "`)", rk["lightgbm"])}

Agreement with the rules rating: **{fmt(rk["agreement_with_rules"])}**; disagreement-queue rate {fmt(rk["disagreement_rate"])};
outcome rate where the challenger rated higher than the rules: {fmt(rk["outcome_rate_where_challenger_higher"])}.
High-flag rate by nationality group (not a feature): {", ".join(f"{k} {fmt(v)}" for k, v in rk["high_flag_rate_by_nationality_group"].items())}
(ratio {fmt(rk["flag_rate_ratio"])}). Labels are synthetic; see the model card.

## 5. Risk-score stability
- Rules monotonicity: {st["rules_monotonicity_violations"]} violations in {st["rules_monotonicity_checks"]} checks (adding a risk factor never lowers the score).
- Identical inputs give identical scores: {st["rules_identical_inputs_identical_score"]}; irrelevant fields ignored: {st["rules_ignore_irrelevant_fields"]}.
- Challenger under an irrelevant perturbation: mean probability change {fmt(st["challenger_mean_abs_change_irrelevant"])},
  rating flips {fmt(st["challenger_rating_flip_rate_irrelevant"])}; repeat runs identical: {st["challenger_repeat_identical"]}.

## 6. Investigation assistant citations
{asst["correct"]} of {asst["questions"]} questions handled correctly (accuracy {fmt(asst["citation_accuracy"])}): answerable questions must be
grounded and cite every ownership edge on the expected paths; unanswerable or restricted questions must be withheld with
no citations (the assistant has no tool that reads cases or reports).
"""


def main() -> int:
    results = {
        "er": eval_er(),
        "ubo": eval_ubo(),
        "screening": eval_screening(),
        "risk": eval_risk(),
        "assistant": eval_assistant(),
    }
    gates = check_gates(results)
    (EVAL_DIR / "results.json").write_text(
        json.dumps({**results, "gates": gates}, indent=1, sort_keys=True, default=str) + "\n"
    )
    (EVAL_DIR / "RESULTS.md").write_text(render(results, gates))
    failed = [g for g in gates if not g["passed"]]
    for g in gates:
        print(f"{'PASS' if g['passed'] else 'FAIL'}  {g['metric']} = {g['actual']} ({g['op']} {g['threshold']})")
    print(f"{len(gates) - len(failed)}/{len(gates)} gates passed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
