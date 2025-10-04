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
2. **Block**: candidate pairs share at least one key from nine families: any identifier (company number, ACN/ABN);
   for people, phonetic surname (Double Metaphone) + birth year, NYSIIS surname + birth year, phonetic surname +
   first initial, any phonetic name token + birth month/year, phonetic given name + surname prefix, postcode + first
   initial; for entities, phonetic name + jurisdiction and normalised-name prefix. Very common keys are capped.
   Blocking recall is measured in the eval (0.98 on the test fold).
3. **Features** (stable ids): Jaro-Winkler and token-set ratio on names, phonetic agreement, birth date exact /
   month-year / transposed day-month, identifier agreement (agree / disagree / missing), address token overlap,
   postcode, nationality, jurisdiction, kind agreement.
4. **Baseline: Fellegi-Sunter** with m/u probabilities estimated by EM on unlabelled blocked pairs; log2
   likelihood-ratio weights per field; shown beside the model as a transparent reference.
5. **Champion: LightGBM pair classifier** trained on labelled pairs built from perturbed Companies House PSC
   records (when downloaded) plus synthetic AU people and companies. Officers' merge decisions are stored so they
   can be added as labelled pairs at the next retraining.
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
   metrics, limits and the decision thresholds. Promoting a different version to champion needs the
   `models:promote` permission (compliance officer only) and a recorded reason, and is audited.

Merges are recorded as `MergeRecord`s and can be split; nothing is deleted.

## Consequences
- Eval gates: F1 of the matcher ≥ the Fellegi-Sunter baseline + a margin, precision at auto-merge ≥ 0.99,
  review rate ≤ the stated target, calibration (Brier/ECE) bounds. Results go to `eval/RESULTS.md` without
  run timestamps.
- Small trained artifacts are committed so the demo scores offline; `make train` reproduces them from fixed seeds.
- Names are personal data: features and metrics leave `data/`, raw register records do not.
