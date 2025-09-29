# Model card: entity-resolution matcher `er-1.0`

**Purpose.** Decide whether two party records (people or entities) describe the same real-world party, so that
ownership and control are traced to one node. Used by Kinroot's merge/split queue; a human decides every pair
in the review band, and every merge can be split again.

**Decision framing.** A false merge is the costly error (it can hide or invent control), so the matcher is
precision-first. Pairs at or above **0.8478** (calibrated probability) merge automatically, pairs from
**0.3902** go to the compliance officer, and the rest are rejected. Thresholds were chosen on the
validation precision-recall curve: precision >= 0.99 at auto-merge; recall >= 0.995 at review (validation PR curve, calibrated). On top of the probability, a pair with a hard conflict
(different full dates of birth, different registration numbers, or clearly different addresses) is never merged
automatically; it goes to review. Expected review-queue rate: 0.0312.

## Data
- Source: Companies House PSC individuals (perturbed) + synthetic AU people and companies. Labels come from construction (which records were derived from the same
  entity), including deliberate hard negatives: namesakes, relatives at one address, sibling companies.
- Leakage control: each entity belongs to exactly one fold (train / valid / calib / test) and only within-fold
  pairs are used, so no person or company is seen in training and scored in test.
- Pairs come from the production blocking function. Blocking recall on the test fold:
  0.9822 (39142 blocked pairs, 6810 true pairs).
- Training negatives are subsampled to 194299 pairs (all hard negatives kept);
  validation, calibration and test keep the natural blocked-pair distribution.
- Personal data stays in the git-ignored `data/` folder; only features, labels and coarse origin groups are
  written to `eval/fixtures/er_test_pairs.csv.gz`.

## Features
`name_jaro_winkler`, `name_token_set`, `name_phonetic_agree`, `surname_jaro_winkler`, `given_name_agree`, `dob_exact`, `dob_partial`, `dob_transposed`, `dob_year_diff`, `id_agree`, `address_token_overlap`, `postcode_agree`, `nationality_agree`, `jurisdiction_agree`, `kind_agree`. Monotone constraints on the three name-similarity features.

## Results (held-out test fold)
| Model | Precision | Recall | F1 | Avg precision | Brier | ECE |
|---|---|---|---|---|---|---|
| Fellegi-Sunter (EM) | 0.8861 | 0.9232 | 0.9042 | 0.9546 | 0.0401 | 0.0408 |
| Logistic regression | 0.9782 | 0.9816 | 0.9799 | 0.9973 | 0.0055 | 0.0012 |
| Random forest | 0.9823 | 0.9883 | 0.9853 | 0.9986 | 0.0044 | 0.0035 |
| LightGBM (calibrated) | 0.9732 | 0.9928 | 0.9829 | 0.9985 | 0.0044 | 0.0013 |

At the operating thresholds: auto-merge precision 0.9914 (47 false merges),
recall at the review threshold 0.9973, review-queue rate 0.0368.
Calibration before isotonic: Brier 0.0043, ECE 0.0011.

Tuning: Optuna TPE, 40 trials on validation average precision
(best 0.9989), 353 boosting rounds.

## Explanations
Per-pair reasons use exact TreeSHAP contributions mapped to plain language ("Same date of birth",
"Different company numbers"); the five largest are shown. Global importance (mean |SHAP|): `dob_partial` 2.8438, `dob_year_diff` 2.4463, `id_agree` 2.2597, `name_token_set` 1.9984, `address_token_overlap` 1.559, `dob_exact` 1.2396.

## Fairness check (people, by name origin, test fold)
Name origin is never a feature; it is used only to check that the matcher works comparably across naming
conventions.

| Name origin | Pairs | Recall at review | Auto-merge precision | Review rate |
|---|---|---|---|---|
| anglo | 3920 | 1.0 | 1.0 | 0.0612 |
| arabic | 234 | 1.0 | 1.0 | 0.0641 |
| chinese | 721 | 1.0 | 1.0 | 0.061 |
| korean_japanese | 564 | 1.0 | 1.0 | 0.0248 |
| mediterranean | 701 | 1.0 | 1.0 | 0.0399 |
| south_asian | 958 | 1.0 | 1.0 | 0.0553 |
| uk_register | 7113 | 0.9982 | 0.9857 | 0.0952 |
| vietnamese | 952 | 1.0 | 1.0 | 0.0473 |

## Limitations
- Labels are constructed, not observed: real duplicates can be messier (aliases, transliteration schemes,
  shared corporate service addresses). Officers' merge decisions are stored and can be added as labelled pairs.
- The register publishes birth month and year only; the day is synthesised, so day-level features are tested
  on synthetic variation.
- Companies are mostly synthetic Australian names; a firm-specific book may need recalibration.
- The champion is promoted only with compliance-officer sign-off; the logistic baseline is kept as a registered
  challenger (`er-1.0-logreg`).
