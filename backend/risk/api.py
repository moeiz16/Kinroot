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

from . import service


def assess_client(org_id: uuid.UUID, client_id: uuid.UUID, actor: Actor) -> RiskAssessmentView:
    """Run the published methodology + challenger; persist a RiskAssessment; open a disagreement review when
    they disagree; cache the rating on the client. Deterministic for identical inputs (inputs_hash)."""
    return service.assess_client(org_id, client_id, actor)


def assess_org(org_id: uuid.UUID, actor: Actor) -> int:
    return service.assess_org(org_id, actor)


def latest_assessment(org_id: uuid.UUID, client_id: uuid.UUID) -> RiskAssessmentView | None:
    return service.latest_assessment(org_id, client_id)


def assessment_history(org_id: uuid.UUID, client_id: uuid.UUID) -> list[RiskAssessmentView]:
    return service.assessment_history(org_id, client_id)


def override_rating(
    org_id: uuid.UUID, client_id: uuid.UUID, rating: RiskRating, reason: str, actor: Actor
) -> RiskAssessmentView:
    """Compliance-officer override (can raise, or lower with a reason of >= 20 chars). Audited."""
    return service.override_rating(org_id, client_id, rating, reason, actor)


def edd_requirements(org_id: uuid.UUID, client_id: uuid.UUID) -> list[EddTrigger]:
    """Current EDD triggers and the measures each requires (from the latest assessment + screening)."""
    return service.edd_requirements(org_id, client_id)


def list_disagreements(
    org_id: uuid.UUID,
    *,
    status: Literal["open", "resolved"] | None = "open",
    offset: int = 0,
    limit: int = 25,
) -> Page[dict]:
    """[{id, clientId, clientName, rulesRating, challengerRating, probabilityHigh, reasons, status, createdAt}]"""
    return service.list_disagreements(org_id, status=status, offset=offset, limit=limit)


def resolve_disagreement(
    org_id: uuid.UUID,
    disagreement_id: uuid.UUID,
    outcome: Literal["keep_rules", "override_to_challenger", "methodology_issue"],
    note: str,
    actor: Actor,
) -> dict:
    return service.resolve_disagreement(org_id, disagreement_id, outcome, note, actor)


def methodology_versions(org_id: uuid.UUID) -> list[dict]:
    """[{id, version, status: draft|published|retired, publishedAt, publishedBy, rules: [...], bands: {...}}]"""
    return service.methodology_versions(org_id)


def publish_methodology(org_id: uuid.UUID, methodology_id: uuid.UUID, actor: Actor) -> dict:
    return service.publish_methodology(org_id, methodology_id, actor)


def model_registry() -> list[dict]:
    """Both models (entity resolution + risk challenger): versions, stage (champion/challenger/retired),
    metrics, calibration, PSI drift, model card markdown, mlflow run id."""
    return service.model_registry()


def promote_model(model_name: str, version: str, actor: Actor, note: str) -> dict:
    """Champion/challenger promotion with sign-off (compliance officer); audited."""
    return service.promote_model(model_name, version, actor, note)


def seed_methodologies(org_id: uuid.UUID) -> int:
    """Create KR-RM-1.0 (published) and the KR-RM-1.1 draft for an org (idempotent). Seed and new firms."""
    return service.seed_methodologies(org_id)


def model_drift() -> dict:
    """PSI of the risk challenger's current inputs and scores against its training reference."""
    return service.drift("risk-challenger")
