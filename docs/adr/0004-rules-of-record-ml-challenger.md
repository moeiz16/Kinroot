# ADR 0004: Rules are the decision of record; an ML model runs beside them as a challenger

**Status:** accepted

## Context
AML/CTF programs must apply a documented, explainable risk methodology that the firm can defend to the regulator
and that its compliance officer owns. Learned models catch combinations rules miss, but a black-box rating is not
acceptable as the decision of record.

## Decision
- **Rules methodology (decision of record)**: versioned (`KR-RM-x.y`), points per factor (customer, structure,
  jurisdiction, service, channel, screening), rating bands, and EDD triggers. Inputs include graph features
  (layers to the UBO, cycles, offshore and high-risk jurisdictions, nominee indicators, officer-cluster size,
  unexplained ownership, PEP or sanctions hits in the structure). Each point carries a regulator-readable reason
  and evidence ids. Only a published version is used; publishing is audited and needs `methodology:manage`.
- **Challenger**: calibrated LightGBM on the same rule and graph features, trained on labelled synthetic client
  outcomes (seeded generator with realistic base rates and label noise), with a logistic-regression baseline and
  a random-forest comparison; group/time-aware split; Optuna tuning; isotonic calibration; SHAP reasons.
- **Disagreement → review**: when the challenger's rating differs from the rules by a band and its probability
  is clearly on the other side of its threshold, a `Disagreement` is opened for the compliance officer
  (keep rules / override / flag a methodology issue). The challenger never changes a rating by itself.
- **Fairness**: protected attributes (nationality as a proxy, sex, age) are never features; nationality and age
  bands are used only to test for disparate challenger flags, reported in the model card.
- **Stability**: unit tests assert monotonic behaviour (adding a sanctions hit never lowers the score), score
  stability under irrelevant perturbations, and identical outputs for identical inputs (`inputsHash`).
- **Monitoring**: PSI drift on challenger inputs and scores; agreement rate tracked; promotion of a new champion
  requires sign-off.

## Consequences
- The UI shows the rules rating as the rating; the challenger appears as a "second opinion" with its reasons.
- Eval reports AUC, Brier/ECE, agreement rate with the rules and stability results (`eval/RESULTS.md`).
- Synthetic labels limit what the challenger proves; the model card says so plainly.
