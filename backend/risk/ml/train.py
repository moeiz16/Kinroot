"""Train the risk challenger (ADR 0004). Run: `python manage.py train risk` (under the heavy lock).

Framing: predict P(the relationship later needs enhanced action) from the same rule and graph features the
methodology reads. The rules stay the decision of record; the model is a second opinion whose job is to spot
combinations the points miss. Metrics: ROC-AUC and average precision (ranking), Brier and ECE (calibration,
because the probability is shown to the compliance officer), agreement with the rules rating (how often a
human has to look), and stability under irrelevant perturbations.

Baselines: the rules score itself (as a scorecard), logistic regression; comparison: random forest; champion:
LightGBM tuned with Optuna on the validation cohort and isotonic-calibrated on a separate calibration cohort.
Split is time-ordered by onboarding month.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from resolution.ml.common import (
    Isotonic,
    best_f1_threshold,
    binary_metrics,
    mlflow_run,
    quantile_edges,
    r4,
    register_version,
    sha256,
    strip_lightgbm_dump,
    write_csv_gz,
    write_json,
)

from .. import rules as rules_engine
from ..features import FEATURE_LABELS, ML_FEATURES
from .data import SETTINGS, generate, split

log = logging.getLogger(__name__)
VERSION = "rc-1.0"
LR_VERSION = "rc-1.0-logreg"
RATING = {"low": 0, "medium": 1, "high": 2}


def challenger_rating(p: np.ndarray | float, thr: dict[str, float]) -> np.ndarray:
    p = np.asarray(p, float)
    return np.where(p >= thr["high"], 2, np.where(p >= thr["medium"], 1, 0))


def disagrees(rules_rating: int, p: float, thr: dict[str, float], margin: float) -> bool:
    """Ratings differ by a band AND the probability sits clearly on the other side of the boundary.

    Upward (the challenger sees more risk): any band. Downward: only against a high rules rating, where an
    over-rating costs real enhanced-due-diligence effort; medium-versus-low differences are not queued."""
    c = int(challenger_rating(p, thr))
    if c == rules_rating:
        return False
    if c > rules_rating:
        boundary = thr["high"] if c == 2 else thr["medium"]
        return p - boundary > margin or (c - rules_rating == 2 and p - thr["medium"] > margin)
    return rules_rating == 2 and thr["high"] - p > margin


def rules_scores(df: pd.DataFrame, methodology: dict[str, Any]) -> tuple[np.ndarray, np.ndarray]:
    scores, ratings = [], []
    for row in df[list(ML_FEATURES)].to_dict("records"):
        res = rules_engine.apply(methodology, row)
        scores.append(res.score)
        ratings.append(RATING[res.rating])
    return np.array(scores, float), np.array(ratings, int)


def train(
    out_dir: Path, *, seed: int | None = None, trials: int = 40, eval_dir: Path | None = None, track: bool = True
) -> dict[str, Any]:
    import lightgbm as lgb
    import optuna
    import shap
    from sklearn.ensemble import RandomForestClassifier
    from sklearn.linear_model import LogisticRegression
    from sklearn.metrics import average_precision_score, roc_auc_score

    cfg = json.loads(SETTINGS.read_text())
    seed = int(seed if seed is not None else cfg["seed"])
    thr = cfg["rating_thresholds"]
    margin = float(cfg["disagreement_margin"])
    df = generate(seed=seed)
    folds = split(df)
    tr, ca, va, te = folds["train"], folds["calib"], folds["valid"], folds["test"]
    X = lambda d: d[list(ML_FEATURES)].to_numpy(float)  # noqa: E731
    Xtr, ytr, Xca, yca, Xva, yva, Xte, yte = (
        X(tr),
        tr.label.to_numpy(),
        X(ca),
        ca.label.to_numpy(),
        X(va),
        va.label.to_numpy(),
        X(te),
        te.label.to_numpy(),
    )
    methodology = rules_engine.default_methodologies()[0]

    # rules as a scorecard baseline (score / 100 as a ranking signal)
    rs_te, rr_te = rules_scores(te, methodology)
    rules_metrics = {
        "roc_auc": r4(roc_auc_score(yte, rs_te)),
        "average_precision": r4(average_precision_score(yte, rs_te)),
    }

    # logistic regression baseline (standardised)
    mean, scale = Xtr.mean(axis=0), Xtr.std(axis=0)
    scale[scale == 0] = 1.0
    lr = LogisticRegression(C=0.5, max_iter=3000, random_state=seed).fit((Xtr - mean) / scale, ytr)
    lr_raw = lambda M: lr.predict_proba((M - mean) / scale)[:, 1]  # noqa: E731
    lr_cal = Isotonic().fit(lr_raw(Xca), yca)
    lr_te = lr_cal(lr_raw(Xte))

    rf = RandomForestClassifier(n_estimators=400, min_samples_leaf=5, n_jobs=2, random_state=seed).fit(Xtr, ytr)
    rf_te = rf.predict_proba(Xte)[:, 1]

    dtrain = lgb.Dataset(
        Xtr, ytr, feature_name=list(ML_FEATURES), free_raw_data=False, params={"feature_pre_filter": False}
    )
    base = {
        "objective": "binary",
        "verbosity": -1,
        "seed": seed,
        "deterministic": True,
        "force_row_wise": True,
        "num_threads": 2,
    }

    def objective(trial: optuna.Trial) -> float:
        params = {
            **base,
            "num_leaves": trial.suggest_int("num_leaves", 4, 48, log=True),
            "learning_rate": trial.suggest_float("learning_rate", 0.01, 0.15, log=True),
            "min_child_samples": trial.suggest_int("min_child_samples", 20, 200, log=True),
            "feature_fraction": trial.suggest_float("feature_fraction", 0.5, 1.0),
            "bagging_fraction": trial.suggest_float("bagging_fraction", 0.6, 1.0),
            "bagging_freq": 1,
            "lambda_l2": trial.suggest_float("lambda_l2", 1e-3, 20.0, log=True),
        }
        booster = lgb.train(
            params,
            dtrain,
            num_boost_round=800,
            valid_sets=[lgb.Dataset(Xva, yva, reference=dtrain)],
            callbacks=[lgb.early_stopping(50, verbose=False)],
        )
        trial.set_user_attr("best_iteration", booster.best_iteration or 800)
        return float(roc_auc_score(yva, booster.predict(Xva, num_iteration=booster.best_iteration)))

    optuna.logging.set_verbosity(optuna.logging.WARNING)
    study = optuna.create_study(direction="maximize", sampler=optuna.samplers.TPESampler(seed=seed))
    study.optimize(objective, n_trials=trials)
    best = dict(study.best_params)
    rounds = int(study.best_trial.user_attrs["best_iteration"])
    booster = lgb.train({**base, **best, "bagging_freq": 1}, dtrain, num_boost_round=rounds)
    cal = Isotonic().fit(np.asarray(booster.predict(Xca), float), yca)
    gb_te = cal(np.asarray(booster.predict(Xte), float))
    gb_raw_te = np.asarray(booster.predict(Xte), float)

    # agreement with the rules on the latest cohort
    ch_te = challenger_rating(gb_te, thr)
    agree = float(np.mean(ch_te == rr_te))
    dis = np.array([disagrees(int(r), float(p), thr, margin) for r, p in zip(rr_te, gb_te, strict=True)])
    # were the disagreements useful? outcome rate where the challenger is higher vs lower than the rules
    up, down = dis & (ch_te > rr_te), dis & (ch_te < rr_te)
    disagreement = {
        "rate": r4(dis.mean()),
        "challenger_higher": int(up.sum()),
        "challenger_lower": int(down.sum()),
        "outcome_rate_when_challenger_higher": r4(yte[up].mean()) if up.any() else None,
        "outcome_rate_when_challenger_lower": r4(yte[down].mean()) if down.any() else None,
        "outcome_rate_overall": r4(yte.mean()),
    }
    # stability: irrelevant perturbation (counts nudged within their band) and identical inputs
    rng = np.random.default_rng(seed)
    Xp = Xte.copy()
    j = list(ML_FEATURES).index("n_services")
    Xp[:, j] = np.clip(Xp[:, j] + rng.choice([0, 0, 1], len(Xp)), 1, None)
    stability = {
        "repeat_identical": bool(np.array_equal(cal(np.asarray(booster.predict(Xte), float)), gb_te)),
        "mean_abs_change_irrelevant_perturbation": r4(
            np.mean(np.abs(cal(np.asarray(booster.predict(Xp), float)) - gb_te))
        ),
        "rating_flip_rate_irrelevant_perturbation": r4(
            np.mean(challenger_rating(cal(np.asarray(booster.predict(Xp), float)), thr) != ch_te)
        ),
    }
    # fairness (protected attributes are never features)
    fairness: dict[str, Any] = {}
    flagged = ch_te == 2
    for col in ("nationality_group", "age_band"):
        groups: dict[str, dict[str, Any]] = {}
        for g, idx in te.groupby(col).groups.items():
            idx = np.asarray(list(idx))
            pos = yte[idx] == 1
            groups[str(g)] = {
                "n": len(idx),
                "high_flag_rate": r4(flagged[idx].mean()),
                "true_positive_rate": r4(flagged[idx][pos].mean()) if pos.any() else None,
                "outcome_rate": r4(yte[idx].mean()),
            }
        rates = [float(v["high_flag_rate"]) for k, v in groups.items() if k != "entity" and v["n"] >= 50]
        fairness[col] = {
            "groups": groups,
            "flag_rate_ratio_min_max": r4(min(rates) / max(rates)) if rates and max(rates) > 0 else None,
        }
    # global explanation
    sv = shap.TreeExplainer(booster).shap_values(Xte)
    sv = sv[1] if isinstance(sv, list) else sv
    importance = {
        f: r4(v) for f, v in sorted(zip(ML_FEATURES, np.abs(sv).mean(axis=0), strict=True), key=lambda t: -t[1])
    }
    # drift reference (PSI) on training inputs and scores
    reference = {
        "features": {f: _hist(Xtr[:, i]) for i, f in enumerate(ML_FEATURES) if f in DRIFT_FEATURES},
        "score": _hist(cal(np.asarray(booster.predict(Xtr), float))),
    }
    metrics: dict[str, Any] = {
        "rules_scorecard": rules_metrics,
        "logistic_regression": binary_metrics(yte, lr_te, best_f1_threshold(yva, lr_cal(lr_raw(Xva)))),
        "random_forest": binary_metrics(yte, rf_te, 0.5),
        "lightgbm": binary_metrics(yte, gb_te, thr["high"]),
        "lightgbm_uncalibrated": {k: binary_metrics(yte, gb_raw_te)[k] for k in ("brier", "ece")},
        "agreement_with_rules": r4(agree),
        "disagreement": disagreement,
        "rating_mix_challenger": {k: int((ch_te == v).sum()) for k, v in RATING.items()},
        "rating_mix_rules": {k: int((rr_te == v).sum()) for k, v in RATING.items()},
    }

    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "lightgbm.txt").write_text(booster.model_to_string())
    strip_lightgbm_dump(out_dir / "lightgbm.txt")
    write_json(out_dir / "calibrator.json", cal.to_dict())
    write_json(
        out_dir / "logreg.json",
        {
            "features": list(ML_FEATURES),
            "mean": [r4(v) for v in mean],
            "scale": [r4(v) for v in scale],
            "coef": [r4(v) for v in lr.coef_[0]],
            "intercept": r4(lr.intercept_[0]),
        },
    )
    write_json(out_dir / "logreg_calibrator.json", lr_cal.to_dict())
    write_json(
        out_dir / "policy.json",
        {"rating_thresholds": thr, "disagreement_margin": margin, "outcome": "enhanced action needed within 24 months"},
    )
    write_json(out_dir / "drift_reference.json", reference)
    report = {
        "version": VERSION,
        "seed": seed,
        "data": {
            "clients": len(df),
            "base_rate": r4(df.label.mean()),
            "folds": {k: {"n": len(v), "base_rate": r4(v.label.mean())} for k, v in folds.items()},
            "split": "time-ordered by onboarding month",
        },
        "tuning": {
            "trials": trials,
            "best_params": {k: (r4(v) if isinstance(v, float) else v) for k, v in best.items()},
            "rounds": rounds,
            "best_valid_auc": r4(study.best_value),
        },
        "metrics_test": metrics,
        "stability": stability,
        "fairness": fairness,
        "global_importance_mean_abs_shap": importance,
        "policy": {"rating_thresholds": thr, "disagreement_margin": margin},
    }
    write_json(out_dir / "metrics.json", report)
    (out_dir / "model_card.md").write_text(model_card(report))
    write_json(
        out_dir / "manifest.json",
        {
            "name": "risk-challenger",
            "champion": VERSION,
            "features": list(ML_FEATURES),
            "versions": {
                VERSION: {
                    "kind": "lightgbm",
                    "model": "lightgbm.txt",
                    "calibrator": "calibrator.json",
                    "stage": "champion",
                    "card": "model_card.md",
                    "metrics": metrics["lightgbm"],
                },
                LR_VERSION: {
                    "kind": "logreg",
                    "model": "logreg.json",
                    "calibrator": "logreg_calibrator.json",
                    "stage": "challenger",
                    "card": "model_card.md",
                    "metrics": metrics["logistic_regression"],
                },
            },
            "files": {
                p.name: sha256(p)
                for p in sorted(out_dir.iterdir())
                if p.suffix in (".txt", ".json") and p.name != "manifest.json"
            },
        },
    )
    if eval_dir is not None:
        cols = [*ML_FEATURES, "label", "nationality_group", "age_band", "month"]
        write_csv_gz(eval_dir / "risk_test_clients.csv.gz", te[cols])
    if track:
        with mlflow_run("kinroot-risk", VERSION, tags={"model": "risk-challenger"}) as mlflow:
            if mlflow is not None:
                mlflow.log_params(
                    {"seed": seed, "trials": trials, "rounds": rounds, **{f"lgb_{k}": v for k, v in best.items()}}
                )
                for name in ("logistic_regression", "random_forest", "lightgbm"):
                    for k, v in metrics[name].items():
                        mlflow.log_metric(f"{name}.{k}", float(v))
                mlflow.log_metric("agreement_with_rules", agree)
                mlflow.log_artifacts(str(out_dir), artifact_path="risk")
                run = mlflow.active_run()
                register_version(
                    "risk-challenger", run.info.run_id, f"{run.info.artifact_uri}/risk", VERSION, "champion"
                )
                register_version(
                    "risk-challenger", run.info.run_id, f"{run.info.artifact_uri}/risk", LR_VERSION, "challenger"
                )
    return report


DRIFT_FEATURES = (
    "n_layers_to_ubo", "n_offshore_entities", "nominee_indicators", "unexplained_pct", "max_officer_appointments",
    "recent_ownership_changes_12m", "channel_remote", "foreign_client", "service_property", "kind_individual",
)  # fmt: skip


def _hist(values: np.ndarray) -> dict[str, list[float]]:
    edges = quantile_edges(values, 10)
    counts = np.histogram(values, bins=edges)[0].astype(float)
    return {"edges": edges, "expected": [r4(c / max(1.0, counts.sum())) for c in counts]}


def model_card(r: dict[str, Any]) -> str:
    m = r["metrics_test"]

    def row(name: str, d: dict[str, Any]) -> str:
        return f"| {name} | {d.get('roc_auc', '-')} | {d.get('average_precision', '-')} | {d.get('brier', '-')} | {d.get('ece', '-')} |"

    fair_lines = []
    for col, v in r["fairness"].items():
        for g, s in sorted(v["groups"].items()):
            fair_lines.append(
                f"| {col} | {g} | {s['n']} | {s['high_flag_rate']} | {s['true_positive_rate']} | {s['outcome_rate']} |"
            )
    ratio = {k: v["flag_rate_ratio_min_max"] for k, v in r["fairness"].items()}
    imp = ", ".join(
        f"{FEATURE_LABELS.get(k, k)} {v}" for k, v in list(r["global_importance_mean_abs_shap"].items())[:6]
    )
    d = m["disagreement"]
    return f"""# Model card: risk challenger `{r["version"]}`

**Role.** A second opinion beside the firm's published rules methodology. The rules rating is the decision of
record; the challenger never changes a rating. When it disagrees by a band and its probability sits more than
{r["policy"]["disagreement_margin"]} beyond the boundary, the client goes to the compliance officer's
disagreement queue (keep the rules, override, or flag a methodology issue).

**Target.** Probability that the relationship later needs enhanced action (a suspicious matter report, an exit
for financial-crime reasons, or a confirmed adverse finding within 24 months). Ratings: high at p ≥
{r["policy"]["rating_thresholds"]["high"]}, medium at p ≥ {r["policy"]["rating_thresholds"]["medium"]}.

## Data
Synthetic clients ({r["data"]["clients"]}, base rate {r["data"]["base_rate"]}) generated with the same feature ids
the live system computes from the ownership graph, screening and onboarding. The outcome is drawn from a latent
risk with interactions the points-based rules cannot express, plus noise. Split: {r["data"]["split"]}
(train / calibration / validation / test cohorts). **Synthetic labels limit what this model proves**: it shows
the pipeline, controls and monitoring a real deployment needs, and should be retrained on the firm's own
reviewed outcomes before it is relied on.

## Results (latest cohort, held out)
| Model | ROC-AUC | Avg precision | Brier | ECE |
|---|---|---|---|---|
{row("Rules score (scorecard baseline)", m["rules_scorecard"])}
{row("Logistic regression", m["logistic_regression"])}
{row("Random forest", m["random_forest"])}
{row("LightGBM (calibrated)", m["lightgbm"])}

Calibration before isotonic: Brier {m["lightgbm_uncalibrated"]["brier"]}, ECE {m["lightgbm_uncalibrated"]["ece"]}.
Agreement with the rules rating: **{m["agreement_with_rules"]}**. Disagreement queue rate: {d["rate"]}
({d["challenger_higher"]} higher, {d["challenger_lower"]} lower). Outcome rate where the challenger rated higher than
the rules: {d["outcome_rate_when_challenger_higher"]}; where lower: {d["outcome_rate_when_challenger_lower"]}; overall:
{d["outcome_rate_overall"]}.

Tuning: Optuna TPE, {r["tuning"]["trials"]} trials on validation ROC-AUC (best {r["tuning"]["best_valid_auc"]}),
{r["tuning"]["rounds"]} boosting rounds.

## Stability
Identical inputs give identical outputs: {r["stability"]["repeat_identical"]}. An irrelevant perturbation
(number of minor services) moves the probability by {r["stability"]["mean_abs_change_irrelevant_perturbation"]} on
average and flips {r["stability"]["rating_flip_rate_irrelevant_perturbation"]} of challenger ratings.

## Explanations
Per-client reasons use exact TreeSHAP contributions mapped to plain language. Global importance (mean |SHAP|):
{imp}.

## Fairness
Nationality, sex and age are never features. Nationality group and age band are used only here:

| Attribute | Group | n | High-flag rate | True-positive rate | Outcome rate |
|---|---|---|---|---|---|
{chr(10).join(fair_lines)}

Ratio of lowest to highest high-flag rate across groups: {ratio}. Differences track the outcome rates and the
legitimate residence factor (`foreign_client`); they are reviewed at each retraining.

## Monitoring
PSI on ten input features and on the score against the training reference (`drift_reference.json`): stable
below 0.1, watch below 0.25, drift above. Agreement rate is tracked per assessment. A new version is promoted
only with compliance-officer sign-off; the logistic baseline is registered as `{LR_VERSION}`.
"""
