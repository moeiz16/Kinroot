"""Public interface of risk (builder B). ADR 0004: rules are the decision of record; the ML challenger runs
beside them and disagreements go to review.

Rules methodology: versioned JSON (risk.RiskMethodology), points per factor (customer, structure, jurisdiction,
service, channel, screening), rating bands, EDD triggers. Challenger: calibrated LightGBM (logistic-regression
baseline) on rule + graph features; SHAP reasons; disagreement = ratings differ by >= 1 band AND challenger
probability on the far side of its threshold by > 0.15.
"""

from __future__ import annotations

import uuid
from typing import Literal

from kinroot.contracts import Actor, EddTrigger, Page, RiskAssessmentView, RiskRating


def assess_client(org_id: uuid.UUID, client_id: uuid.UUID, actor: Actor) -> RiskAssessmentView:
    """Run the published methodology + challenger; persist a RiskAssessment; open a disagreement review when
    they disagree; cache the rating on the client. Deterministic for identical inputs (inputs_hash)."""
    raise NotImplementedError


def assess_org(org_id: uuid.UUID, actor: Actor) -> int:
    raise NotImplementedError


def latest_assessment(org_id: uuid.UUID, client_id: uuid.UUID) -> RiskAssessmentView | None:
    raise NotImplementedError


def assessment_history(org_id: uuid.UUID, client_id: uuid.UUID) -> list[RiskAssessmentView]:
    raise NotImplementedError


def override_rating(
    org_id: uuid.UUID, client_id: uuid.UUID, rating: RiskRating, reason: str, actor: Actor
) -> RiskAssessmentView:
    """Compliance-officer override (can raise, or lower with a reason of >= 20 chars). Audited."""
    raise NotImplementedError


def edd_requirements(org_id: uuid.UUID, client_id: uuid.UUID) -> list[EddTrigger]:
    """Current EDD triggers and the measures each requires (from the latest assessment + screening)."""
    raise NotImplementedError


def list_disagreements(
    org_id: uuid.UUID,
    *,
    status: Literal["open", "resolved"] | None = "open",
    offset: int = 0,
    limit: int = 25,
) -> Page[dict]:
    """[{id, clientId, clientName, rulesRating, challengerRating, probabilityHigh, reasons, status, createdAt}]"""
    raise NotImplementedError


def resolve_disagreement(
    org_id: uuid.UUID,
    disagreement_id: uuid.UUID,
    outcome: Literal["keep_rules", "override_to_challenger", "methodology_issue"],
    note: str,
    actor: Actor,
) -> dict:
    raise NotImplementedError


def methodology_versions(org_id: uuid.UUID) -> list[dict]:
    """[{id, version, status: draft|published|retired, publishedAt, publishedBy, rules: [...], bands: {...}}]"""
    raise NotImplementedError


def publish_methodology(org_id: uuid.UUID, methodology_id: uuid.UUID, actor: Actor) -> dict:
    raise NotImplementedError


def model_registry() -> list[dict]:
    """Both models (entity resolution + risk challenger): versions, stage (champion/challenger/retired),
    metrics, calibration, PSI drift, model card markdown, mlflow run id."""
    raise NotImplementedError


def promote_model(model_name: str, version: str, actor: Actor, note: str) -> dict:
    """Champion/challenger promotion with sign-off (compliance officer); audited."""
    raise NotImplementedError
