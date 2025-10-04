# ADR 0003: Entity resolution with a Fellegi-Sunter baseline and a gradient-boosted matcher

**Status:** accepted

## Context
The same person or company arrives from several places: onboarding forms, registry imports, other clients'
structures. Missed matches hide control (one person behind four clients); false merges corrupt the ownership
record. Decisions must be explainable and reversible, and a human must review the uncertain middle.

## Decision
Pipeline (all classical, CPU, local):
1. **Normalise**: case-fold, strip honorifics and legal suffixes (Pty Ltd, Ltd, LLC, FZE…), transliterate, split
   name parts; parse partial birth dates; canonicalise ACN/ABN/UK company numbers and postcodes.
2. **Block**: candidate pairs share at least one key: Double Metaphone of surname + birth year, company number,
   normalised-name prefix + jurisdiction, postcode + first initial. Blocking recall is measured in the eval.
3. **Features** (stable ids): Jaro-Winkler and token-set ratio on names, phonetic agreement, birth date exact /
   month-year / transposed day-month, identifier agreement (agree / disagree / missing), address token overlap,
   postcode, nationality, jurisdiction, kind agreement.
4. **Baseline: Fellegi-Sunter** with m/u probabilities estimated by EM on unlabelled blocked pairs; log2
   likelihood-ratio weights per field; shown beside the model as a transparent reference.
5. **Champion: LightGBM pair classifier** trained on labelled pairs built from perturbed Companies House PSC
   records (when downloaded) plus synthetic AU people and companies, and later from officers' merge decisions.
   Logistic regression and random forest are reported challengers. **Group-aware splits** (no source entity in
   both train and test) prevent leakage. Optuna tunes hyperparameters on the validation fold; isotonic
   **calibration** on a held-out fold.
6. **Thresholds from the precision-recall curve** on validation: auto-merge where precision ≥ 0.99, review band
   down to the point where recall ≥ 0.995 (a missed duplicate hides control, and the extra review load is about half
   a percentage point), reject below. The expected review-queue rate is reported with them. A merge policy sits on
   top of the probability: a pair with a hard conflict (different full dates of birth, different registration
   numbers, or clearly different addresses) never merges automatically; it goes to review.
7. **SHAP** (TreeExplainer) per pair, translated into plain reasons ("Same date of birth", "Different company
   numbers"), top five by absolute contribution.
8. MLflow (local SQLite + artifacts in `mlruns/`) tracks runs and the registry; a model card documents data,
   metrics, limits and the decision thresholds. Champion/challenger promotion needs compliance-officer sign-off.

Merges are recorded as `MergeRecord`s and can be split; nothing is deleted.

## Consequences
- Eval gates: F1 of the matcher ≥ the Fellegi-Sunter baseline + a margin, precision at auto-merge ≥ 0.99,
  review rate ≤ the stated target, calibration (Brier/ECE) bounds. Results go to `eval/RESULTS.md` without
  run timestamps.
- Small trained artifacts are committed so the demo scores offline; `make train` reproduces them from fixed seeds.
- Names are personal data: features and metrics leave `data/`, raw register records do not.
