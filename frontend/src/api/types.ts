// Typed mirror of docs/API_CONTRACT.md Part 1 (v1). camelCase on the wire.
// Keep in step with the contract: a shape change there is a change here in the same commit.

export type ISODate = string; // YYYY-MM-DD
export type ISODateTime = string; // ISO-8601 with offset
export type Country = "AU" | "GB";

export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  code: string;
  errors?: { field: string; message: string }[];
  requestId?: string;
}

// 1.2 Auth
export interface User {
  id: string;
  email: string;
  fullName: string;
  avatarColor: string;
  createdAt: ISODateTime;
}
export type Role = "owner" | "compliance_officer" | "partner" | "fee_earner" | "auditor";
export interface OrgSummary {
  id: string;
  name: string;
  slug: string;
  country: Country;
  role: Role;
  roleLabel: string;
}
export interface Org {
  id: string;
  name: string;
  slug: string;
  country: Country;
  abn: string;
  address: string;
  sector: "legal" | "accounting" | "conveyancing" | "real_estate" | "dealer";
  regime: { name: string; commencement: ISODate | null };
  dataResidency: "AU" | "UK";
  createdAt: ISODateTime;
}
export interface Me {
  user: User;
  activeOrg: Org | null;
  membership: { role: Role; roleLabel: string; permissions: string[] } | null;
  orgs: OrgSummary[];
  session: { expiresAt: ISODateTime; absoluteExpiresAt: ISODateTime };
}
export interface SignupBody {
  email: string;
  password: string;
  fullName: string;
  firmName: string;
  country: Country;
}

// 1.4 Org
export interface Member {
  id: string;
  userId: string;
  fullName: string;
  email: string;
  role: Role;
  roleLabel: string;
  status: "active" | "invited";
  joinedAt: ISODateTime | null;
  trainingDueOn: ISODate | null;
}
export interface Invitation {
  id: string;
  email: string;
  role: Role;
  roleLabel?: string;
  expiresAt: ISODateTime;
  acceptedAt: ISODateTime | null;
  createdAt: ISODateTime;
}
export interface InvitationPublic {
  orgName: string;
  email: string;
  role: Role;
  roleLabel: string;
  expiresAt: ISODateTime;
}
export interface OrgSettings {
  retention: { years: number; trigger: "relationship_end"; legalHoldClientIds: string[] };
  reviews: { highMonths: number; mediumMonths: number; lowMonths: number };
  screening: { autoRescreenOnListUpdate: boolean; fuzzyThreshold: number };
  ubo: { thresholdPct: number };
  resolution: { autoMergeEnabled: boolean };
  notifications?: { criticalAlerts: "immediate" | "daily" | "off"; reviewReminderDays: number; signoffRequests: boolean; weeklyDigest: boolean; digestDay: "monday" | "tuesday" | "wednesday" | "thursday" | "friday" };
}
export interface RetentionPreview {
  asOf: ISODate;
  dueCount: number;
  items: {
    recordType: "client" | "document" | "assessment" | "case";
    id: string;
    label: string;
    relationshipEndedOn: ISODate;
    disposableFrom: ISODate;
    legalHold: boolean;
  }[];
}
export interface TrainingRecord {
  id: string;
  userId: string;
  fullName: string;
  course: string;
  completedOn: ISODate | null;
  dueOn: ISODate;
  status: "current" | "due_soon" | "overdue";
}
export interface Job {
  id: string;
  kind: string;
  status: "queued" | "running" | "succeeded" | "failed";
  progress: number;
  result?: unknown;
  error?: string;
  createdAt: ISODateTime;
  finishedAt?: ISODateTime;
}

// 1.5 Dashboard
export type TrayKind = "signoff" | "hit_review" | "merge_review" | "disagreement" | "alert" | "review_due";
export interface TrayItem {
  kind: TrayKind;
  id: string;
  clientId: string | null;
  title: string;
  subtitle: string;
  dueOn: ISODate | null;
  href: string;
}
export interface Dashboard {
  fileTray: TrayItem[];
  counts: Partial<{
    clients: number;
    highRisk: number;
    reviewsOverdue: number;
    reviewsDueSoon: number;
    screeningBacklog: number;
    mergeQueue: number;
    openAlerts: number;
    eddInProgress: number;
    awaitingSignoff: number;
    trainingOverdue: number;
    smrDrafts: number;
  }>;
  ratingMix: { low: number; medium: number; high: number };
  regime: { name: string; commencement: ISODate | null; daysToCommencement: number | null };
  recentActivity: { id: number; action: string; label: string; actorName: string; createdAt: ISODateTime }[];
}
export interface Insight {
  id: string;
  tone: "risk" | "progress" | "info";
  title: string;
  body: string;
  metric?: { value: number; unit: string; trend: "up" | "down" | "flat" };
  href?: string;
}

// 1.6 Clients
export type ClientKind = "individual" | "company" | "trust" | "partnership";
export type Rating = "low" | "medium" | "high";
export type Service =
  | "conveyancing"
  | "company_formation"
  | "trust_formation"
  | "property_transaction"
  | "managing_client_funds"
  | "tax_advice"
  | "audit"
  | "real_estate_sale"
  | "other";
export type ClientFlag = "pep" | "sanctions_review" | "offshore" | "circular" | "nominee" | "review_overdue";
export interface Client {
  id: string;
  kind: ClientKind;
  name: string;
  status: "onboarding" | "active" | "blocked" | "exited";
  jurisdiction: string;
  partyId: string;
  services: Service[];
  channel: "face_to_face" | "remote" | "intermediary";
  matterReference: string | null;
  assignedTo: { id: string; fullName: string } | null;
  rating: Rating | null;
  ratingSource: "rules" | "override" | null;
  eddRequired: boolean;
  nextReviewOn: ISODate | null;
  lastReviewedOn: ISODate | null;
  onboardedOn: ISODate | null;
  relationshipEndedOn?: ISODate | null;
  sample?: boolean;
  structure: { parties: number; layers: number; ubos: number };
  flags: ClientFlag[];
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}
export interface ClientCreate {
  kind: ClientKind;
  name: string;
  jurisdiction: string;
  services: Service[];
  channel: Client["channel"];
  matterReference?: string;
  assignedToId?: string;
  identifiers?: { acn?: string; abn?: string; ukCompanyNumber?: string; trustDeedDate?: string };
  person?: { givenNames: string; familyName: string; birthDate: string; nationality: string; address?: Address };
}
export interface Address {
  line1?: string;
  locality?: string;
  state?: string;
  postcode?: string;
  country?: string;
}
export type PartyKind = "person" | "company" | "trust" | "partnership" | "address";
export interface Identifiers {
  acn?: string;
  abn?: string;
  ukCompanyNumber?: string;
}
export interface Party {
  id: string;
  kind: PartyKind;
  name: string;
  birthDate?: ISODate;
  nationality?: string;
  jurisdiction?: string;
  identifiers: Identifiers;
  address?: Address | string;
  isNominee: boolean;
  dormant?: boolean;
  source: "manual" | "uk_ch" | "au_abr" | "seed" | "import";
  sourceRef?: string;
  mergedInto: string | null;
  createdAt: ISODateTime;
}
export interface PartyCreate {
  kind: PartyKind;
  name: string;
  birthDate?: ISODate;
  nationality?: string;
  jurisdiction?: string;
  identifiers?: Identifiers;
  address?: Address | string;
  isNominee?: boolean;
}
export interface PartyDetail extends Party {
  sourceRecords: PartyRecord[];
  clients: { id: string; name: string }[];
}
export interface Relationship {
  id: string;
  fromPartyId: string;
  toPartyId: string;
  kind: "ownership" | "control";
  pct?: number;
  interest?: string;
  role?: string;
  nominee: boolean;
  validFrom: ISODate;
  validTo: ISODate | null;
  source: string;
  sourceRef?: string;
  evidenceNote?: string;
  createdAt: ISODateTime;
}
export interface RelationshipCreate {
  fromPartyId: string;
  toPartyId: string;
  kind: "ownership" | "control";
  pct?: number;
  interest?: string;
  role?: string;
  nominee?: boolean;
  validFrom: ISODate;
  validTo?: ISODate;
  evidenceNote?: string;
}
export interface Onboarding {
  clientId: string;
  status: Client["status"];
  items: { key: string; label: string; done: boolean; required: boolean; partyId?: string; href?: string }[];
  canSubmit: boolean;
}
export type DocType = "passport" | "drivers_licence" | "birth_certificate" | "trust_deed" | "company_extract" | "other";
export interface DocumentRec {
  id: string;
  partyId: string;
  docType: DocType;
  fileName: string;
  sizeBytes: number;
  sha256: string;
  uploadedBy: string;
  uploadedAt: ISODateTime;
  retainUntil: ISODate;
}
export interface VerificationCheck {
  id: string;
  partyId: string;
  method: "document" | "electronic";
  result: "verified" | "partial" | "failed";
  sources: { name: string; matched: string[] }[];
  reference: string;
  checkedAt: ISODateTime;
}
export interface Consent {
  id: string;
  partyId: string;
  purpose: "identity_verification" | "electronic_check";
  givenOn: ISODate;
  method: string;
  recordedBy: string;
}

// 1.7 Graph (graphology serialisation)
export type NodeFlag =
  | "client"
  | "ubo"
  | "pep"
  | "sanctions_hit"
  | "nominee"
  | "offshore"
  | "high_risk_jurisdiction"
  | "dormant"
  | "unknown_owner"
  | "circular"
  | "merged";
export interface GraphNodeAttributes {
  label: string;
  kind: PartyKind | "unknown" | "stack";
  jurisdiction?: string | null;
  identifiers?: Identifiers;
  flags: NodeFlag[];
  clientId: string | null;
  riskRating: Rating | null;
  level: number;
  effectivePct: number | null;
  mergedCount: number;
  // optional extras the web understands when present
  count?: number;
  sub?: string;
}
export interface GraphEdgeAttributes {
  kind: "ownership" | "control" | "address" | "unknown" | "shared";
  label: string;
  pct: number | null;
  interest?: string | null;
  role: string | null;
  nominee: boolean;
  validFrom: ISODate | null;
  validTo: ISODate | null;
  sourceRef: string | null;
  citation?: string; // "E-07"
}
export interface GraphPayload {
  attributes: { focusId: string | null; asOf: ISODate; depth: number; truncated: boolean; graphVersion: number };
  nodes: { key: string; attributes: GraphNodeAttributes }[];
  edges: { key: string; source: string; target: string; attributes: GraphEdgeAttributes }[];
}
export type GraphNode = GraphNodeAttributes & { id: string };
export type GraphEdge = GraphEdgeAttributes & { id: string; source: string; target: string };

export interface PathHop {
  edgeId: string;
  fromId: string;
  toId: string;
  kind: "ownership" | "control";
  pct?: number | null;
  role?: string | null;
}
export interface GraphPath {
  nodeIds: string[];
  hops: PathHop[];
  effectivePct?: number | null;
  sentence: string;
}
export interface BeneficialOwner {
  partyId: string;
  name: string;
  kind: PartyKind;
  effectivePct?: number | null;
  via: "ownership" | "control" | "both";
  controlRoles: string[];
  isUbo: boolean;
  paths: GraphPath[];
  explanation: string;
}
export type UboWarning = "circular_ownership" | "unknown_owner" | "depth_limit" | "over_allocated" | "nominee_in_chain";
export interface UboResult {
  clientId: string;
  asOf: ISODate;
  thresholdPct: number;
  owners: BeneficialOwner[];
  unexplainedPct: number;
  cycles: string[][];
  warnings: UboWarning[];
  computedAt: ISODateTime;
}
export interface GraphDiff {
  clientId: string;
  fromDate: ISODate;
  toDate: ISODate;
  added: GraphEdge[];
  removed: GraphEdge[];
  changed: { before: GraphEdge; after: GraphEdge; fields: string[] }[];
  nodesAdded: GraphNode[];
  nodesRemoved: GraphNode[];
  summary: string[];
}
export interface ThreadResult {
  partyId: string;
  asOf: ISODate;
  entries: { clientId: string; clientName: string; effectivePct?: number | null; roles: string[]; paths: GraphPath[] }[];
  nodeIds: string[];
  edgeIds: string[];
}
export interface ConnectionResult {
  fromId: string;
  toId: string;
  found: boolean;
  paths: GraphPath[];
}
export interface Cluster {
  id: string;
  kind: "shared_officer" | "shared_address" | "nominee";
  label: string;
  reason: string;
  partyIds: string[];
  clientIds: string[];
  size: number;
}

// 1.8 Resolution
export interface PartyRecord {
  id: string;
  kind: PartyKind;
  name: string;
  birthDate?: ISODate;
  nationality?: string;
  jurisdiction?: string;
  identifiers: Identifiers & { passport?: string };
  address?: Address | string;
  source: string;
  sourceRef?: string;
}
export interface MatchReason {
  feature: string;
  label: string;
  direction: "for" | "against";
  contribution: number;
  value: number | string | null;
}
export interface MatchScore {
  probability: number;
  band: "auto_merge" | "review" | "reject";
  fsWeight: number;
  fsProbability: number;
  features: Record<string, number>;
  reasons: MatchReason[];
  modelVersion: string;
}
export interface MatchCandidate {
  id: string;
  status: "pending" | "merged" | "auto_merged" | "not_match" | "deferred";
  left: PartyRecord;
  right: PartyRecord;
  score: MatchScore;
  clientIds: string[];
  createdAt: ISODateTime;
  decidedBy?: string;
  decidedAt?: ISODateTime;
  note?: string;
}
export interface MergeOutcome {
  candidateId?: string;
  survivorId: string;
  mergedIds: string[];
  status: string;
}
export interface Thresholds {
  autoMerge: number;
  review: number;
  modelVersion: string;
  chosenBy: string;
  expectedReviewRate: number;
}

// 1.9 Screening
export interface ListEntry {
  id: string;
  listKind: "sanctions" | "pep" | "adverse_media";
  name: string;
  aliases: string[];
  birthDate?: string;
  countries: string[];
  programs: string[];
  source: string;
  url?: string;
}
export interface ScreeningHit {
  id: string;
  clientId: string;
  partyId: string;
  partyName: string;
  entry: ListEntry;
  score: number;
  reasons: MatchReason[];
  status: "pending" | "true_match" | "false_positive" | "escalated";
  createdAt: ISODateTime;
  reviewedBy?: string;
  reviewedAt?: ISODateTime;
  reviewReason?: string;
}
export interface ScreeningList {
  list: string;
  source: string;
  version: string;
  entries: number;
  loadedAt: ISODateTime;
  sample: boolean;
}

// 1.10 Risk
export interface RiskReason {
  code: string;
  factor: "customer" | "structure" | "jurisdiction" | "service" | "channel" | "screening";
  points: number;
  message: string;
  evidence: { type: "edge" | "node" | "hit" | "document"; id: string }[];
}
export interface Challenger {
  modelVersion: string;
  probabilityHigh: number;
  rating: Rating;
  agreement: "agree" | "disagree";
  reasons: MatchReason[];
  disagreementId?: string;
}
export interface EddTrigger {
  code: string;
  message: string;
  measures: string[];
}
export interface RiskAssessment {
  id: string;
  clientId: string;
  methodologyVersion: string;
  score: number;
  rating: Rating;
  reasons: RiskReason[];
  challenger: Challenger | null;
  eddRequired: boolean;
  eddTriggers: EddTrigger[];
  inputsHash: string;
  assessedAt: ISODateTime;
  override: { rating: Rating; reason: string; byName: string; at: ISODateTime } | null;
}
export interface Methodology {
  id: string;
  version: string;
  status: "draft" | "published" | "retired";
  publishedAt?: ISODateTime;
  publishedBy?: string;
  bands: { medium: number; high: number };
  rules: { code: string; factor: string; description: string; points: number; condition: string }[];
}
export type MeasureKey =
  | "source_of_wealth"
  | "source_of_funds"
  | "senior_approval"
  | "ubo_verification"
  | "purpose_of_relationship"
  | "adverse_media_check"
  | "enhanced_monitoring";
export interface Edd {
  clientId: string;
  required: boolean;
  triggers: EddTrigger[];
  measures: {
    key: MeasureKey;
    label: string;
    status: "todo" | "done" | "not_applicable";
    note?: string;
    documentIds: string[];
    completedBy?: string;
    completedAt?: ISODateTime;
  }[];
  signoffs: { stage: "compliance" | "senior"; decision: "approve" | "reject"; note: string; byName: string; at: ISODateTime }[];
  status: "not_required" | "in_progress" | "awaiting_compliance" | "awaiting_senior" | "approved" | "rejected";
}

// 1.11 Monitoring
export interface Alert {
  id: string;
  clientId: string;
  clientName: string;
  kind:
    | "list_update_hit"
    | "ownership_change"
    | "officer_change"
    | "address_change"
    | "risk_change"
    | "review_due"
    | "model_drift";
  severity: "info" | "warning" | "critical";
  title: string;
  body: string;
  evidence: { type: string; id: string }[];
  status: "open" | "resolved" | "dismissed";
  createdAt: ISODateTime;
  resolvedBy?: string;
  resolvedAt?: ISODateTime;
  resolutionNote?: string;
}
export interface ReviewDue {
  clientId: string;
  clientName: string;
  rating: Rating | null;
  lastReviewedOn: ISODate | null;
  nextReviewOn: ISODate;
  overdueDays: number;
  assignedToName: string | null;
}

// 1.12 Cases
export interface Case {
  id: string;
  clientId: string;
  clientName: string;
  title: string;
  status: "open" | "reported" | "closed_no_report";
  grounds: string | null;
  accessLevel: "full" | "summary";
  redactedFields: string[];
  openedBy: string;
  openedAt: ISODateTime;
  deadlineOn: ISODate;
  smrStatus: "none" | "draft" | "submitted";
  access?: { userId: string; fullName: string; level: "full" | "summary" }[];
}
export interface SmrDraft {
  caseId: string;
  version: number;
  regime: "AUSTRAC_SMR" | "UK_SAR";
  suspicionGrounds: string | null;
  subjects: { partyId: string; name: string; role: string }[];
  transactions: { date: ISODate; amount: number; currency: string; description: string }[];
  narrative: string | null;
  attachments: string[];
  updatedBy: string;
  updatedAt: ISODateTime;
  submittedAt?: ISODateTime | null;
  reference?: string | null;
  redactedFields?: string[];
}
export interface CaseTimelineEntry {
  at: ISODateTime;
  actorName: string;
  action: string;
  label: string;
}

// 1.13 Assistant
export interface Citation {
  type: "edge" | "node" | "hit" | "alert";
  id: string;
  label: string;
}
export interface AssistantStep {
  tool: string;
  label: string;
  args: Record<string, unknown>;
  resultCount: number;
}
export interface AssistantAnswer {
  id: string;
  question: string;
  answer: string;
  citations: Citation[];
  steps: AssistantStep[];
  highlight: { nodeIds: string[]; edgeIds: string[] };
  mode: "offline" | "cloud";
  createdAt: ISODateTime;
  grounded: boolean;
}

// 1.14 Audit
export interface AuditEntry {
  id: number;
  action: string;
  label: string;
  actorName: string;
  actorType: "user" | "system";
  resourceType: string | null;
  resourceId: string | null;
  metadata: Record<string, unknown>;
  ip: string | null;
  createdAt: ISODateTime;
  hash: string;
  prevHash: string;
}
export interface AuditVerify {
  valid: boolean;
  checked: number;
  brokenAt: number | null;
}
