"""Shared types between the platform/API layer (builder A) and the domain core (builder B).

FROZEN CONTRACT: field names here mirror the camelCase API shapes in docs/API_CONTRACT.md (snake_case in
Python; the renderer converts). Change only by agreement and update the contract doc in the same commit.

Rules
- Domain-core functions take plain ids (UUID) and dates, never request objects or serializers.
- They return these dataclasses; A's views serialize them with `to_wire()` (dataclasses.asdict + camelCase).
- Every function is org-scoped: an id from another org behaves exactly like a missing id (raise NotFound).
- Dates are `datetime.date`; "as of" means the state valid at the END of that day.
"""

from __future__ import annotations

import dataclasses
import uuid
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any, Literal

# ── Enumerations (wire values) ────────────────────────────────────────────────────────────────────
PartyKind = Literal["person", "company", "trust", "partnership", "other"]
NodeKind = Literal["person", "company", "trust", "partnership", "other", "address"]
EdgeKind = Literal["ownership", "control", "address"]
Interest = Literal["shares", "units", "partnership", "trust_entitlement", "voting_rights"]
ControlRole = Literal[
    "director",
    "secretary",
    "trustee",
    "appointor",
    "protector",
    "settlor",
    "beneficiary",
    "partner",
    "nominee_for",
    "significant_control",
    "senior_managing_official",
]
NodeFlag = Literal[
    "client",
    "ubo",
    "pep",
    "sanctions_hit",
    "nominee",
    "offshore",
    "high_risk_jurisdiction",
    "dormant",
    "unknown_owner",
    "circular",
    "merged",
]
RiskRating = Literal["low", "medium", "high"]
MatchBand = Literal["auto_merge", "review", "reject"]
CandidateStatus = Literal["pending", "merged", "auto_merged", "not_match", "deferred"]
ScreeningList = Literal["sanctions", "pep", "adverse_media"]
HitStatus = Literal["pending", "true_match", "false_positive", "escalated"]
AlertKind = Literal[
    "list_update_hit",
    "ownership_change",
    "officer_change",
    "address_change",
    "risk_change",
    "review_due",
    "model_drift",
]
Severity = Literal["info", "warning", "critical"]


class NotFound(Exception):
    """Raised by domain functions for unknown or other-org ids. A maps it to 404."""


class DomainConflict(Exception):
    """Raised when an action conflicts with current state (e.g. deciding an already decided item). A -> 409."""

    def __init__(self, code: str, detail: str) -> None:
        super().__init__(detail)
        self.code = code
        self.detail = detail


@dataclass(frozen=True)
class Page[T]:
    items: list[T]
    total: int


# ── Graph (graph app) ─────────────────────────────────────────────────────────────────────────────
@dataclass
class GraphNode:
    id: str  # Party id (UUID str) or "addr:<hash>" for address nodes
    kind: NodeKind
    label: str
    jurisdiction: str | None = None  # ISO-3166 alpha-2
    identifiers: dict[str, str] = field(default_factory=dict)  # {"acn": "...", "abn": "...", "ukCompanyNumber": "..."}
    flags: list[NodeFlag] = field(default_factory=list)
    client_id: str | None = None  # set when this party is a client of the firm
    risk_rating: RiskRating | None = None
    level: int | None = None  # hop distance from the focus node (layered layout hint)
    effective_pct: float | None = None  # effective ownership of the focus client (people/entities upstream)
    merged_count: int = 0  # number of source records fused into this node


@dataclass
class GraphEdge:
    id: str  # Relationship id (UUID str)
    source: str  # owner / controller / party
    target: str  # owned / controlled entity / address
    kind: EdgeKind
    label: str  # "62%", "Director", "Trustee", "Registered at"
    pct: float | None = None  # ownership edges only
    interest: Interest | None = None
    role: ControlRole | None = None  # control edges only
    nominee: bool = False
    valid_from: date | None = None
    valid_to: date | None = None  # None = current
    source_ref: str | None = None  # "uk_ch:psc:12345678/…", "au_asic:mock:…", "manual"


@dataclass
class GraphView:
    focus_id: str | None
    as_of: date
    nodes: list[GraphNode]
    edges: list[GraphEdge]
    depth: int
    truncated: bool = False  # depth or node cap reached
    graph_version: int = 0  # last applied sync sequence; lets the UI detect stale views


@dataclass
class PathHop:
    edge_id: str
    from_id: str
    to_id: str
    kind: EdgeKind
    pct: float | None = None
    role: ControlRole | None = None


@dataclass
class GraphPath:
    node_ids: list[str]
    hops: list[PathHop]
    effective_pct: float | None = None  # product of ownership pcts; None for control-only paths
    sentence: str = ""  # "Owns 62% of Calder Family Trust's interest in Bellmere Holdings Pty Ltd, which …"


@dataclass
class BeneficialOwner:
    party_id: str
    name: str
    kind: PartyKind
    effective_pct: float | None  # summed over all simple ownership paths
    via: Literal["ownership", "control", "both"]
    control_roles: list[ControlRole]
    is_ubo: bool  # effective_pct >= threshold OR control (AU AML/CTF Rules; UK MLR reg 5/6)
    paths: list[GraphPath]
    explanation: str  # one plain-language sentence for the dossier


@dataclass
class UboResult:
    client_id: str
    as_of: date
    threshold_pct: float
    owners: list[BeneficialOwner]  # UBOs first, then other upstream people above 0%
    unexplained_pct: float  # ownership of the client not traced to a natural person
    cycles: list[list[str]]  # each a list of party ids forming a simple ownership cycle
    warnings: list[
        str
    ]  # "circular_ownership" | "unknown_owner" | "depth_limit" | "over_allocated" | "nominee_in_chain"
    computed_at: datetime | None = None


@dataclass
class EdgeChange:
    before: GraphEdge
    after: GraphEdge
    fields: list[str]  # e.g. ["pct"]


@dataclass
class GraphDiff:
    client_id: str
    from_date: date
    to_date: date
    added: list[GraphEdge]
    removed: list[GraphEdge]
    changed: list[EdgeChange]
    nodes_added: list[GraphNode]
    nodes_removed: list[GraphNode]
    summary: list[str]  # plain sentences: "Kestrel Ventures Ltd became a 100% owner on 1 Feb 2021"


@dataclass
class ThreadEntry:
    client_id: str
    client_name: str
    effective_pct: float | None
    roles: list[ControlRole]
    paths: list[GraphPath]


@dataclass
class ThreadResult:
    party_id: str
    as_of: date
    entries: list[ThreadEntry]  # every client this party owns or controls, directly or indirectly
    node_ids: list[str]  # union of nodes on all paths (for highlighting)
    edge_ids: list[str]


@dataclass
class ConnectionResult:
    from_id: str
    to_id: str
    found: bool
    paths: list[GraphPath]  # shortest first, at most 3


@dataclass
class Cluster:
    id: str
    kind: Literal["shared_officer", "shared_address", "nominee"]
    label: str  # "Gregory Pell directs 41 companies"
    reason: str
    party_ids: list[str]
    client_ids: list[str]
    size: int


@dataclass
class GraphFeatures:
    """Inputs the risk rules and the challenger read from the graph. Names are stable feature ids."""

    client_id: str
    as_of: date
    n_layers_to_ubo: int  # longest simple ownership chain to a natural person
    n_ubos: int
    unexplained_pct: float
    has_cycle: bool
    n_offshore_entities: int
    high_risk_jurisdictions: list[str]
    trust_in_chain: bool
    nominee_indicators: int
    max_officer_appointments: int  # most appointments held by any officer in the structure
    dormant_linked_companies: int
    shared_officer_cluster_size: int
    shared_address_cluster_size: int
    pep_in_structure: bool
    sanctions_hit_in_structure: bool
    recent_ownership_changes_12m: int


@dataclass
class SyncStatus:
    graph_version: int
    pending: int
    last_applied_at: datetime | None


# ── Entity resolution (resolution app) ────────────────────────────────────────────────────────────
@dataclass
class PartyRecord:
    id: str
    kind: PartyKind
    name: str
    birth_date: date | None = None
    nationality: str | None = None
    jurisdiction: str | None = None
    identifiers: dict[str, str] = field(default_factory=dict)
    address: str | None = None
    source: str = "manual"  # manual | uk_ch | au_abr | seed | import
    source_ref: str | None = None


@dataclass
class MatchReason:
    feature: str  # stable id, e.g. "name_jaro_winkler"
    label: str  # plain language: "Names are almost identical"
    direction: Literal["for", "against"]
    contribution: float  # SHAP value on the log-odds scale
    value: str  # human-readable value: "0.97", "same", "differs by 1 day"


@dataclass
class MatchScore:
    probability: float  # calibrated gradient-boosted match probability, 0..1
    band: MatchBand
    fs_weight: float  # Fellegi-Sunter log2 likelihood-ratio weight (baseline)
    fs_probability: float
    features: dict[str, float]
    reasons: list[MatchReason]  # top 5 by |contribution|
    model_version: str


@dataclass
class MatchCandidateView:
    id: str
    status: CandidateStatus
    left: PartyRecord
    right: PartyRecord
    score: MatchScore
    client_ids: list[str]  # clients whose structures include either record
    created_at: datetime
    decided_by: str | None = None  # user full name
    decided_at: datetime | None = None
    note: str | None = None


@dataclass
class MergeOutcome:
    candidate_id: str | None
    survivor_id: str
    merged_ids: list[str]
    status: CandidateStatus


@dataclass
class Thresholds:
    auto_merge: float  # probability >= -> merged without review
    review: float  # probability >= -> review queue; below -> rejected
    model_version: str
    chosen_by: str  # "precision >= 0.99 at auto-merge; recall >= 0.98 at review (validation PR curve)"
    expected_review_rate: float


# ── Screening (screening app) ─────────────────────────────────────────────────────────────────────
@dataclass
class ListEntryView:
    id: str  # list entry id (OpenSanctions id or SAMPLE-…)
    list_kind: ScreeningList
    name: str
    aliases: list[str]
    birth_date: str | None  # partial dates allowed: "1971" or "1971-04"
    countries: list[str]
    programs: list[str]  # sanction programmes / PEP positions
    source: str  # "opensanctions:au_dfat_sanctions@2025-10-10" | "bundled-sample@2025.10"
    url: str | None = None


@dataclass
class ScreeningHitView:
    id: str
    client_id: str
    party_id: str
    party_name: str
    entry: ListEntryView
    score: float  # 0..1 name+attribute match score
    reasons: list[MatchReason]
    status: HitStatus
    created_at: datetime
    reviewed_by: str | None = None
    reviewed_at: datetime | None = None
    review_reason: str | None = None


@dataclass
class ScreeningRunResult:
    run_id: str
    client_id: str | None  # None = whole book (list-update re-screen)
    screened_parties: int
    new_hits: int
    list_versions: dict[str, str]


# ── Risk (risk app) ───────────────────────────────────────────────────────────────────────────────
@dataclass
class RiskReason:
    code: str  # rule id, e.g. "offshore_layer"
    factor: Literal["customer", "structure", "jurisdiction", "service", "channel", "screening"]
    points: int
    message: str  # regulator-readable sentence
    evidence: list[dict[str, str]]  # [{"type": "edge"|"node"|"hit"|"document", "id": "..."}]


@dataclass
class ChallengerView:
    model_version: str
    probability_high: float  # calibrated P(high-risk outcome)
    rating: RiskRating
    agreement: Literal["agree", "disagree"]
    reasons: list[MatchReason]  # SHAP reasons translated to plain language (same shape as ER reasons)
    disagreement_id: str | None = None


@dataclass
class EddTrigger:
    code: str  # "pep", "high_risk_jurisdiction", "complex_structure", "sanctions_near_match", "high_rating", ...
    message: str
    measures: list[str]  # measure keys required, e.g. "source_of_wealth", "senior_approval"


@dataclass
class RiskAssessmentView:
    id: str
    client_id: str
    methodology_version: str
    score: int  # 0..100
    rating: RiskRating
    reasons: list[RiskReason]
    challenger: ChallengerView | None
    edd_required: bool
    edd_triggers: list[EddTrigger]
    inputs_hash: str
    assessed_at: datetime
    override: dict[str, Any] | None = None  # {rating, reason, byName, at}


# ── Monitoring (monitoring app) ───────────────────────────────────────────────────────────────────
@dataclass
class AlertView:
    id: str
    client_id: str
    client_name: str
    kind: AlertKind
    severity: Severity
    title: str
    body: str
    evidence: list[dict[str, str]]
    status: Literal["open", "resolved", "dismissed"]
    created_at: datetime
    resolved_by: str | None = None
    resolved_at: datetime | None = None
    resolution_note: str | None = None


# ── Investigation assistant (assistant app) ───────────────────────────────────────────────────────
@dataclass
class Citation:
    type: Literal["edge", "node", "hit", "alert"]
    id: str
    label: str  # "Bellmere Holdings Pty Ltd owns 80% of Kestrel Ventures Ltd (since 1 Mar 2020)"


@dataclass
class AssistantStep:
    tool: Literal["find_party", "who_controls", "path_between", "changes_since", "screening_status", "risk_reasons"]
    label: str  # business-friendly: "Traced ownership of Harbour Quay Developments"
    args: dict[str, Any]
    result_count: int


@dataclass
class AssistantAnswer:
    id: str
    question: str
    answer: str  # every factual sentence ends with [n] markers pointing into `citations`
    citations: list[Citation]
    steps: list[AssistantStep]
    highlight: dict[str, list[str]]  # {"nodeIds": [...], "edgeIds": [...]} for the canvas
    mode: Literal["offline", "cloud"]
    created_at: datetime
    grounded: bool  # every claim cites a graph element; False -> answer withheld with a safe message


# ── Platform services B may call (implemented by A) ───────────────────────────────────────────────
@dataclass
class Actor:
    """Who performs an action. `user_id=None` means the system (jobs, scheduled re-screens)."""

    org_id: uuid.UUID
    user_id: uuid.UUID | None
    name: str = "System"
    ip: str | None = None


def to_wire(obj: Any) -> Any:
    """Dataclass (or list of them) -> plain dict tree for the camelCase renderer."""
    if dataclasses.is_dataclass(obj) and not isinstance(obj, type):
        return {f.name: to_wire(getattr(obj, f.name)) for f in dataclasses.fields(obj)}
    if isinstance(obj, list | tuple):
        return [to_wire(v) for v in obj]
    if isinstance(obj, dict):
        return {k: to_wire(v) for k, v in obj.items()}
    if isinstance(obj, datetime | date):
        return obj.isoformat()
    if isinstance(obj, uuid.UUID):
        return str(obj)
    return obj
