# Model card: risk challenger `rc-1.0`

**Role.** A second opinion beside the firm's published rules methodology. The rules rating is the decision of
record; the challenger never changes a rating. When it disagrees by a band and its probability sits more than
0.15 beyond the boundary, the client goes to the compliance officer's
disagreement queue (keep the rules, override, or flag a methodology issue).

**Target.** Probability that the relationship later needs enhanced action (a suspicious matter report, an exit
for financial-crime reasons, or a confirmed adverse finding within 24 months). Ratings: high at p ≥
0.5, medium at p ≥ 0.2.

## Data
Synthetic clients (30000, base rate 0.1019) generated with the same feature ids
the live system computes from the ownership graph, screening and onboarding. The outcome is drawn from a latent
risk with interactions the points-based rules cannot express, plus noise. Split: time-ordered by onboarding month
(train / calibration / validation / test cohorts). **Synthetic labels limit what this model proves**: it shows
the pipeline, controls and monitoring a real deployment needs, and should be retrained on the firm's own
reviewed outcomes before it is relied on.

## Results (latest cohort, held out)
| Model | ROC-AUC | Avg precision | Brier | ECE |
|---|---|---|---|---|
| Rules score (scorecard baseline) | 0.8544 | 0.5555 | - | - |
| Logistic regression | 0.8713 | 0.6363 | 0.0526 | 0.0079 |
| Random forest | 0.8703 | 0.6702 | 0.0516 | 0.0078 |
| LightGBM (calibrated) | 0.8754 | 0.6694 | 0.0499 | 0.0106 |

Calibration before isotonic: Brier 0.0497, ECE 0.0072.
Agreement with the rules rating: **0.768**. Disagreement queue rate: 0.0464
(68 higher, 170 lower). Outcome rate where the challenger rated higher than
the rules: 0.6471; where lower: 0.2235; overall:
0.0997.

Tuning: Optuna TPE, 40 trials on validation ROC-AUC (best 0.902),
71 boosting rounds.

## Stability
Identical inputs give identical outputs: True. An irrelevant perturbation
(number of minor services) moves the probability by 0.0014 on
average and flips 0.0012 of challenger ratings.

## Explanations
Per-client reasons use exact TreeSHAP contributions mapped to plain language. Global importance (mean |SHAP|):
Offshore entities in the structure 0.3322, Ownership not traced to a person 0.2372, Nominee arrangements 0.165, High-risk jurisdictions 0.1638, Officers shared with other clients 0.1225, Officer appointments elsewhere 0.1105.

## Fairness
Nationality, sex and age are never features. Nationality group and age band are used only here:

| Attribute | Group | n | High-flag rate | True-positive rate | Outcome rate |
|---|---|---|---|---|---|
| nationality_group | born_in_country | 3535 | 0.0696 | 0.5418 | 0.105 |
| nationality_group | born_overseas | 1591 | 0.0566 | 0.4571 | 0.088 |
| age_band | 18-34 | 664 | 0.0015 | 0.0312 | 0.0482 |
| age_band | 35-54 | 932 | 0.0 | 0.0 | 0.0365 |
| age_band | 55+ | 655 | 0.0 | 0.0 | 0.0366 |
| age_band | entity | 2875 | 0.1165 | 0.6271 | 0.1464 |

Ratio of lowest to highest high-flag rate across groups: {'nationality_group': 0.8132, 'age_band': 0.0}. Differences track the outcome rates and the
legitimate residence factor (`foreign_client`); they are reviewed at each retraining.

## Monitoring
PSI on ten input features and on the score against the training reference (`drift_reference.json`): stable
below 0.1, watch below 0.25, drift above. Agreement rate is tracked per assessment. A new version is promoted
only with compliance-officer sign-off; the logistic baseline is registered as `rc-1.0-logreg`.
