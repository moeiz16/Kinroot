"""Train the entity-resolution matcher (ADR 0003). Run: `python manage.py train er` (under the heavy lock).

Problem framing: binary classification of blocked record pairs (same real-world party or not). The costly error
is a false merge (it corrupts the ownership record and can hide or invent control), so the operating point is
precision-first: auto-merge only where validation precision >= 0.99, send the uncertain middle to a human, and
reject below the point that keeps recall >= 0.98. Metrics: precision / recall / F1 at the operating points,
average precision (threshold-free), Brier and ECE for calibration, and the review-queue rate (human workload).

Models: Fellegi-Sunter (EM, unsupervised) and logistic regression baselines, a random forest comparison, and
the LightGBM champion tuned with Optuna on the validation fold and calibrated with isotonic regression on a
separate calibration fold. Thresholds come from the validation precision-recall curve; the test fold is touched
once, for the reported numbers.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from ..features import FEATURES
from ..fellegi_sunter import FellegiSunter
from ..model import conflicting_evidence, logreg_design
from .common import (
    Isotonic,
    best_f1_threshold,
    binary_metrics,
    mlflow_run,
    precision_threshold,
    r4,
    recall_threshold,
    register_version,
    sha256,
    strip_lightgbm_dump,
    write_csv_gz,
    write_json,
)
from .data import PairGenerator, feature_matrix, fold, strip_personal

log = logging.getLogger(__name__)
VERSION = "er-1.0"
LR_VERSION = "er-1.0-logreg"
AUTO_MERGE_PRECISION = 0.99
REVIEW_RECALL = 0.995
MONOTONE = {"name_jaro_winkler": 1, "name_token_set": 1, "surname_jaro_winkler": 1}


def _subsample_train(df: pd.DataFrame, ratio: int, seed: int) -> pd.DataFrame:
    pos = df[df.label == 1]
    neg = df[df.label == 0]
    hard = neg[neg.hard_negative == 1]
    rest = neg[neg.hard_negative == 0]
    keep = min(len(rest), max(0, ratio * len(pos) - len(hard)))
    rest = rest.sample(n=keep, random_state=seed) if keep < len(rest) else rest
    return pd.concat([pos, hard, rest]).sample(frac=1.0, random_state=seed).reset_index(drop=True)


def _lgb_params(trial_params: dict[str, Any], seed: int) -> dict[str, Any]:
    return {
        "objective": "binary",
        "verbosity": -1,
        "seed": seed,
        "deterministic": True,
        "force_row_wise": True,
        "num_threads": 2,
        "monotone_constraints": [MONOTONE.get(f, 0) for f in FEATURES],
        **trial_params,
    }


def train(
    out_dir: Path,
    *,
    seed: int | None = None,
    trials: int = 40,
    scale: float = 1.0,
    eval_dir: Path | None = None,
    track: bool = True,
) -> dict[str, Any]:
    import lightgbm as lgb
    import optuna
    from sklearn.ensemble import RandomForestClassifier
    from sklearn.linear_model import LogisticRegression
    from sklearn.metrics import average_precision_score

    gen = PairGenerator(seed, scale=scale)
    seed = gen.seed
    df, data_stats = gen.build_pairs()
    train_df = _subsample_train(fold(df, "train"), gen.cfg["negatives_per_positive_train"], seed)
    valid, calib, test = fold(df, "valid"), fold(df, "calib"), fold(df, "test")
    Xtr, ytr = feature_matrix(train_df), train_df.label.to_numpy()
    Xva, yva = feature_matrix(valid), valid.label.to_numpy()
    Xca, yca = feature_matrix(calib), calib.label.to_numpy()
    Xte, yte = feature_matrix(test), test.label.to_numpy()
    rows = lambda d: d[list(FEATURES)].to_dict("records")  # noqa: E731

    # ── Fellegi-Sunter (unsupervised EM on the training pairs, labels unused) ──
    fs = FellegiSunter().fit(rows(train_df), prior=float(ytr.mean()))
    fs_va = fs.probabilities(rows(valid))
    fs_t = best_f1_threshold(yva, fs_va)
    fs_te = fs.probabilities(rows(test))

    # ── Logistic regression baseline ──
    Dtr = logreg_design(Xtr)
    mean, scale_ = Dtr.mean(axis=0), Dtr.std(axis=0)
    scale_[scale_ == 0] = 1.0
    lr = LogisticRegression(C=1.0, max_iter=2000, random_state=seed)
    lr.fit((Dtr - mean) / scale_, ytr)
    lr_raw = lambda X: lr.predict_proba((logreg_design(X) - mean) / scale_)[:, 1]  # noqa: E731
    lr_cal = Isotonic().fit(lr_raw(Xca), yca)
    lr_va, lr_te = lr_cal(lr_raw(Xva)), lr_cal(lr_raw(Xte))
    lr_thr = {
        "auto_merge": r4(precision_threshold(yva, lr_va, AUTO_MERGE_PRECISION)),
        "review": r4(recall_threshold(yva, lr_va, REVIEW_RECALL)),
    }

    # ── Random forest comparison ──
    rf = RandomForestClassifier(n_estimators=300, min_samples_leaf=3, n_jobs=2, random_state=seed)
    rf.fit(Xtr, ytr)
    rf_te = rf.predict_proba(Xte)[:, 1]
    rf_t = best_f1_threshold(yva, rf.predict_proba(Xva)[:, 1])

    # ── LightGBM champion: Optuna on the validation fold ──
    dtrain = lgb.Dataset(
        Xtr, ytr, feature_name=list(FEATURES), free_raw_data=False, params={"feature_pre_filter": False}
    )

    def objective(trial: optuna.Trial) -> float:
        params = _lgb_params(
            {
                "num_leaves": trial.suggest_int("num_leaves", 8, 64, log=True),
                "learning_rate": trial.suggest_float("learning_rate", 0.02, 0.2, log=True),
                "min_child_samples": trial.suggest_int("min_child_samples", 10, 120, log=True),
                "feature_fraction": trial.suggest_float("feature_fraction", 0.6, 1.0),
                "bagging_fraction": trial.suggest_float("bagging_fraction", 0.6, 1.0),
                "bagging_freq": 1,
                "lambda_l2": trial.suggest_float("lambda_l2", 1e-3, 10.0, log=True),
            },
            seed,
        )
        dvalid = lgb.Dataset(Xva, yva, reference=dtrain)
        booster = lgb.train(
            params, dtrain, num_boost_round=600, valid_sets=[dvalid], callbacks=[lgb.early_stopping(40, verbose=False)]
        )
        trial.set_user_attr("best_iteration", booster.best_iteration or 600)
        return float(average_precision_score(yva, booster.predict(Xva, num_iteration=booster.best_iteration)))

    optuna.logging.set_verbosity(optuna.logging.WARNING)
    study = optuna.create_study(direction="maximize", sampler=optuna.samplers.TPESampler(seed=seed))
    study.optimize(objective, n_trials=trials)
    best = dict(study.best_params)
    rounds = int(study.best_trial.user_attrs["best_iteration"])
    params = _lgb_params({**best, "bagging_freq": 1}, seed)
    booster = lgb.train(params, dtrain, num_boost_round=rounds)
    raw_ca = np.asarray(booster.predict(Xca), float)
    cal = Isotonic().fit(raw_ca, yca)
    gb_va, gb_te = cal(np.asarray(booster.predict(Xva), float)), cal(np.asarray(booster.predict(Xte), float))
    gb_raw_te = np.asarray(booster.predict(Xte), float)

    conflict_va = np.array([conflicting_evidence(r) for r in rows(valid)], bool)
    auto = precision_threshold(yva, gb_va, AUTO_MERGE_PRECISION)
    review = min(recall_threshold(yva, gb_va, REVIEW_RECALL), auto - 1e-4)
    thresholds: dict[str, Any] = {
        "auto_merge": r4(auto),
        "review": r4(review),
        "model_version": VERSION,
        "chosen_by": (
            f"precision >= {AUTO_MERGE_PRECISION} at auto-merge; recall >= {REVIEW_RECALL} at review "
            "(validation PR curve, calibrated)"
        ),
        "expected_review_rate": r4(float(np.mean((gb_va >= review) & ((gb_va < auto) | conflict_va)))),
    }

    def operating(p: np.ndarray, y: np.ndarray, thr: dict[str, float], frame: pd.DataFrame) -> dict[str, float]:
        conflict = np.array([conflicting_evidence(r) for r in frame[list(FEATURES)].to_dict("records")], bool)
        auto_mask = (p >= thr["auto_merge"]) & ~conflict
        rev_mask = (p >= thr["review"]) & ~auto_mask
        captured = (p >= thr["review"]) & (y == 1)
        return {
            "auto_merge_precision": r4(y[auto_mask].mean()) if auto_mask.any() else 1.0,
            "auto_merge_share_of_matches": r4((auto_mask & (y == 1)).sum() / max(1, (y == 1).sum())),
            "review_rate": r4(rev_mask.mean()),
            "recall_at_review": r4(captured.sum() / max(1, (y == 1).sum())),
            "false_merges": int((auto_mask & (y == 0)).sum()),
        }

    metrics = {
        "fellegi_sunter": binary_metrics(yte, fs_te, fs_t),
        "logistic_regression": {
            **binary_metrics(yte, lr_te, best_f1_threshold(yva, lr_va)),
            **operating(lr_te, yte, lr_thr, test),
        },
        "random_forest": binary_metrics(yte, rf_te, rf_t),
        "lightgbm": {**binary_metrics(yte, gb_te, 0.5), **operating(gb_te, yte, thresholds, test)},
        "lightgbm_uncalibrated": {
            "brier": binary_metrics(yte, gb_raw_te)["brier"],
            "ece": binary_metrics(yte, gb_raw_te)["ece"],
        },
    }
    # fairness: does the matcher work equally well across name origins? (people only)
    fairness: dict[str, dict[str, float]] = {}
    people = test[test.kind == "person"]
    conflict_te = np.array([conflicting_evidence(r) for r in rows(test)], bool)
    for origin, grp in people.groupby("origin"):
        idx = grp.index.to_numpy()
        y, p, cf = yte[idx], gb_te[idx], conflict_te[idx]
        if (y == 1).sum() < 15:
            continue
        auto_m = (p >= thresholds["auto_merge"]) & ~cf
        fairness[str(origin)] = {
            "pairs": len(idx),
            "recall_at_review": r4(((p >= thresholds["review"]) & (y == 1)).sum() / (y == 1).sum()),
            "auto_merge_precision": r4(y[auto_m].mean()) if auto_m.any() else 1.0,
            "review_rate": r4(((p >= thresholds["review"]) & ~auto_m).mean()),
        }
    # global explanation: mean |TreeSHAP| on the test fold
    import shap

    sample = Xte[: min(len(Xte), 3000)]
    sv = shap.TreeExplainer(booster).shap_values(sample)
    sv = sv[1] if isinstance(sv, list) else sv
    importance = {f: r4(v) for f, v in sorted(zip(FEATURES, np.abs(sv).mean(axis=0), strict=True), key=lambda t: -t[1])}

    # ── artifacts ──
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "lightgbm.txt").write_text(booster.model_to_string())
    strip_lightgbm_dump(out_dir / "lightgbm.txt")
    write_json(out_dir / "calibrator.json", cal.to_dict())
    write_json(out_dir / "fellegi_sunter.json", fs.to_dict())
    write_json(
        out_dir / "logreg.json",
        {
            "features": list(FEATURES),
            "design": "features + missing indicators",
            "mean": [r4(v) for v in mean],
            "scale": [r4(v) for v in scale_],
            "coef": [r4(v) for v in lr.coef_[0]],
            "intercept": r4(lr.intercept_[0]),
        },
    )
    write_json(out_dir / "logreg_calibrator.json", lr_cal.to_dict())
    write_json(out_dir / "thresholds.json", thresholds)
    write_json(
        out_dir / "thresholds_logreg.json",
        {
            **lr_thr,
            "model_version": LR_VERSION,
            "chosen_by": thresholds["chosen_by"],
            "expected_review_rate": r4(float(np.mean((lr_va >= lr_thr["review"]) & (lr_va < lr_thr["auto_merge"])))),
        },
    )
    report = {
        "version": VERSION,
        "seed": seed,
        "data": {**data_stats, "train_pairs_after_negative_sampling": len(train_df)},
        "tuning": {
            "trials": trials,
            "best_params": {k: (r4(v) if isinstance(v, float) else v) for k, v in best.items()},
            "rounds": rounds,
            "best_valid_average_precision": r4(study.best_value),
        },
        "metrics_test": metrics,
        "fs_threshold": r4(fs_t),
        "thresholds": thresholds,
        "fairness_by_name_origin": fairness,
        "global_importance_mean_abs_shap": importance,
    }
    write_json(out_dir / "metrics.json", report)
    (out_dir / "model_card.md").write_text(model_card(report))
    write_json(
        out_dir / "manifest.json",
        {
            "name": "er-matcher",
            "champion": VERSION,
            "features": list(FEATURES),
            "fellegi_sunter": "fellegi_sunter.json",
            "versions": {
                VERSION: {
                    "kind": "lightgbm",
                    "model": "lightgbm.txt",
                    "calibrator": "calibrator.json",
                    "thresholds": "thresholds.json",
                    "stage": "champion",
                    "card": "model_card.md",
                    "metrics": metrics["lightgbm"],
                },
                LR_VERSION: {
                    "kind": "logreg",
                    "model": "logreg.json",
                    "calibrator": "logreg_calibrator.json",
                    "thresholds": "thresholds_logreg.json",
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
    # held-out features (no personal data) so the eval and CI reproduce the reported numbers
    if eval_dir is not None:
        write_csv_gz(eval_dir / "er_test_pairs.csv.gz", strip_personal(test))

    if track:
        with mlflow_run("kinroot-er", VERSION, tags={"model": "er-matcher"}) as mlflow:
            if mlflow is not None:
                mlflow.log_params(
                    {"seed": seed, "trials": trials, "rounds": rounds, **{f"lgb_{k}": v for k, v in best.items()}}
                )
                for model_name, m in metrics.items():
                    for k, v in m.items():
                        if isinstance(v, (int, float)):
                            mlflow.log_metric(f"{model_name}.{k}", float(v))
                mlflow.log_artifacts(str(out_dir), artifact_path="er")
                run = mlflow.active_run()
                register_version("er-matcher", run.info.run_id, f"{run.info.artifact_uri}/er", VERSION, "champion")
                register_version("er-matcher", run.info.run_id, f"{run.info.artifact_uri}/er", LR_VERSION, "challenger")
    return report


def model_card(r: dict[str, Any]) -> str:
    m = r["metrics_test"]
    t = r["thresholds"]

    def row(name: str, d: dict[str, Any]) -> str:
        return (
            f"| {name} | {d.get('precision', '-')} | {d.get('recall', '-')} | {d.get('f1', '-')} | {d.get('average_precision', '-')} | "
            f"{d.get('brier', '-')} | {d.get('ece', '-')} |"
        )

    folds = r["data"]["folds"]
    fair = "\n".join(
        f"| {k} | {v['pairs']} | {v['recall_at_review']} | {v['auto_merge_precision']} | {v['review_rate']} |"
        for k, v in sorted(r["fairness_by_name_origin"].items())
    )
    imp = ", ".join(f"`{k}` {v}" for k, v in list(r["global_importance_mean_abs_shap"].items())[:6])
    return f"""# Model card: entity-resolution matcher `{r["version"]}`

**Purpose.** Decide whether two party records (people or entities) describe the same real-world party, so that
ownership and control are traced to one node. Used by Kinroot's merge/split queue; a human decides every pair
in the review band, and every merge can be split again.

**Decision framing.** A false merge is the costly error (it can hide or invent control), so the matcher is
precision-first. Pairs at or above **{t["auto_merge"]}** (calibrated probability) merge automatically, pairs from
**{t["review"]}** go to the compliance officer, and the rest are rejected. Thresholds were chosen on the
validation precision-recall curve: {t["chosen_by"]}. On top of the probability, a pair with a hard conflict
(different full dates of birth, different registration numbers, or clearly different addresses) is never merged
automatically; it goes to review. Expected review-queue rate: {t["expected_review_rate"]}.

## Data
- Source: {r["data"]["source"]}. Labels come from construction (which records were derived from the same
  entity), including deliberate hard negatives: namesakes, relatives at one address, sibling companies.
- Leakage control: each entity belongs to exactly one fold (train / valid / calib / test) and only within-fold
  pairs are used, so no person or company is seen in training and scored in test.
- Pairs come from the production blocking function. Blocking recall on the test fold:
  {folds["test"]["blocking_recall"]} ({folds["test"]["pairs"]} blocked pairs, {folds["test"]["true_pairs"]} true pairs).
- Training negatives are subsampled to {r["data"]["train_pairs_after_negative_sampling"]} pairs (all hard negatives kept);
  validation, calibration and test keep the natural blocked-pair distribution.
- Personal data stays in the git-ignored `data/` folder; only features, labels and coarse origin groups are
  written to `eval/fixtures/er_test_pairs.csv.gz`.

## Features
{", ".join(f"`{f}`" for f in FEATURES)}. Monotone constraints on the three name-similarity features.

## Results (held-out test fold)
| Model | Precision | Recall | F1 | Avg precision | Brier | ECE |
|---|---|---|---|---|---|---|
{row("Fellegi-Sunter (EM)", m["fellegi_sunter"])}
{row("Logistic regression", m["logistic_regression"])}
{row("Random forest", m["random_forest"])}
{row("LightGBM (calibrated)", m["lightgbm"])}

At the operating thresholds: auto-merge precision {m["lightgbm"]["auto_merge_precision"]} ({m["lightgbm"]["false_merges"]} false merges),
recall at the review threshold {m["lightgbm"]["recall_at_review"]}, review-queue rate {m["lightgbm"]["review_rate"]}.
Calibration before isotonic: Brier {m["lightgbm_uncalibrated"]["brier"]}, ECE {m["lightgbm_uncalibrated"]["ece"]}.

Tuning: Optuna TPE, {r["tuning"]["trials"]} trials on validation average precision
(best {r["tuning"]["best_valid_average_precision"]}), {r["tuning"]["rounds"]} boosting rounds.

## Explanations
Per-pair reasons use exact TreeSHAP contributions mapped to plain language ("Same date of birth",
"Different company numbers"); the five largest are shown. Global importance (mean |SHAP|): {imp}.

## Fairness check (people, by name origin, test fold)
Name origin is never a feature; it is used only to check that the matcher works comparably across naming
conventions.

| Name origin | Pairs | Recall at review | Auto-merge precision | Review rate |
|---|---|---|---|---|
{fair}

## Limitations
- Labels are constructed, not observed: real duplicates can be messier (aliases, transliteration schemes,
  shared corporate service addresses). Officers' merge decisions are stored and can be added as labelled pairs.
- The register publishes birth month and year only; the day is synthesised, so day-level features are tested
  on synthetic variation.
- Companies are mostly synthetic Australian names; a firm-specific book may need recalibration.
- The champion is promoted only with compliance-officer sign-off; the logistic baseline is kept as a registered
  challenger (`{LR_VERSION}`).
"""
