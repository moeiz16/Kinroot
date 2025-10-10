// One typed function per contract endpoint (docs/API_CONTRACT.md Part 1).
import { http } from "./client";
import type * as T from "./types";

const enc = encodeURIComponent;

export const api = {
  auth: {
    csrf: () => http.get<void>("/auth/csrf"),
    me: () => http.get<T.Me>("/auth/me"),
    login: (email: string, password: string) => http.post<T.Me>("/auth/login", { email, password }),
    signup: (body: T.SignupBody) => http.post<T.Me>("/auth/signup", body),
    logout: () => http.post<void>("/auth/logout"),
    refresh: () => http.post<{ expiresAt: string; absoluteExpiresAt: string }>("/auth/refresh"),
    switchOrg: (orgId: string) => http.post<T.Me>("/auth/switch-org", { orgId }),
    password: (currentPassword: string, newPassword: string) => http.post<void>("/auth/password", { currentPassword, newPassword }),
  },
  org: {
    get: () => http.get<T.Org>("/org"),
    patch: (body: Partial<Pick<T.Org, "name" | "abn" | "address" | "country" | "sector">>) => http.patch<T.Org>("/org", body),
    members: () => http.get<T.Member[]>("/org/members"),
    patchMember: (id: string, role: T.Role) => http.patch<T.Member>(`/org/members/${enc(id)}`, { role }),
    removeMember: (id: string) => http.del<void>(`/org/members/${enc(id)}`),
    invitations: () => http.get<T.Invitation[]>("/org/invitations"),
    invite: (email: string, role: T.Role) => http.post<{ invitation: T.Invitation; inviteUrl: string }>("/org/invitations", { email, role }),
    revokeInvitation: (id: string) => http.del<void>(`/org/invitations/${enc(id)}`),
  },
  invitations: {
    get: (token: string) => http.get<T.InvitationPublic>(`/invitations/${enc(token)}`),
    accept: (token: string, body: { fullName?: string; password?: string }) => http.post<T.Me>(`/invitations/${enc(token)}/accept`, body),
  },
  settings: {
    get: () => http.get<T.OrgSettings>("/settings"),
    patch: (body: Partial<T.OrgSettings>) => http.patch<T.OrgSettings>("/settings", body),
    retentionPreview: () => http.get<T.RetentionPreview>("/settings/retention/preview"),
    retentionRun: (dryRun = true) => http.post<T.Job>("/settings/retention/run", { dryRun }),
  },
  training: {
    list: () => http.get<T.TrainingRecord[]>("/training"),
    add: (body: { userId: string; course: string; completedOn: string; evidenceNote?: string }) => http.post<T.TrainingRecord>("/training", body),
  },
  dashboard: () => http.get<T.Dashboard>("/dashboard"),
  insights: () => http.get<T.Insight[]>("/insights"),
  clients: {
    list: (q: { q?: string; kind?: string; rating?: string; status?: string; reviewDue?: boolean; assignedTo?: "me"; page?: number; pageSize?: number } = {}) =>
      http.get<T.Page<T.Client>>("/clients", q),
    get: (id: string) => http.get<T.Client>(`/clients/${enc(id)}`),
    create: (body: T.ClientCreate) => http.post<T.Client>("/clients", body),
    patch: (id: string, body: Partial<Pick<T.Client, "name" | "services" | "channel" | "matterReference">> & { assignedToId?: string }) =>
      http.patch<T.Client>(`/clients/${enc(id)}`, body),
    parties: (id: string) => http.get<T.Party[]>(`/clients/${enc(id)}/parties`),
    addParty: (id: string, body: T.PartyCreate) => http.post<T.Party>(`/clients/${enc(id)}/parties`, body),
    onboarding: (id: string) => http.get<T.Onboarding>(`/clients/${enc(id)}/onboarding`),
    documents: (id: string) => http.get<T.DocumentRec[]>(`/clients/${enc(id)}/documents`),
    verifications: (id: string) => http.get<T.VerificationCheck[]>(`/clients/${enc(id)}/verification`),
    consents: (id: string) => http.get<T.Consent[]>(`/clients/${enc(id)}/consent`),
    upload: (id: string, file: File, partyId: string, docType: T.DocType) => {
      const form = new FormData();
      form.set("file", file);
      form.set("partyId", partyId);
      form.set("docType", docType);
      return http.upload<T.DocumentRec>(`/clients/${enc(id)}/documents`, form);
    },
    verify: (id: string, body: { partyId: string; method: "document" | "electronic"; documentIds: string[] }) =>
      http.post<T.VerificationCheck>(`/clients/${enc(id)}/verification`, body),
    consent: (id: string, body: { partyId: string; purpose: T.Consent["purpose"]; givenOn: string; method: string }) =>
      http.post<T.Consent>(`/clients/${enc(id)}/consent`, body),
    submit: (id: string) => http.post<{ client: T.Client; jobs: T.Job[] }>(`/clients/${enc(id)}/submit`),
    communicate: (id: string, kind: "information_request" | "exit_notice", message: string) =>
      http.post<void>(`/clients/${enc(id)}/communications`, { kind, message }),
    exit: (id: string, reason: string) => http.post<T.Client>(`/clients/${enc(id)}/exit`, { reason }),
    screen: (id: string) => http.post<T.Job>(`/clients/${enc(id)}/screen`),
    risk: (id: string) => http.get<T.RiskAssessment | null>(`/clients/${enc(id)}/risk`),
    riskHistory: (id: string) => http.get<T.RiskAssessment[]>(`/clients/${enc(id)}/risk/history`),
    assess: (id: string) => http.post<T.RiskAssessment>(`/clients/${enc(id)}/risk/assess`),
    override: (id: string, rating: T.Rating, reason: string) => http.post<T.RiskAssessment>(`/clients/${enc(id)}/risk/override`, { rating, reason }),
    edd: (id: string) => http.get<T.Edd>(`/clients/${enc(id)}/edd`),
    eddMeasure: (id: string, key: string, body: { status: "done" | "not_applicable"; note: string; documentIds?: string[] }) =>
      http.post<T.Edd>(`/clients/${enc(id)}/edd/measures/${enc(key)}`, body),
    signoff: (id: string, body: { stage: "compliance" | "senior"; decision: "approve" | "reject"; note: string }) =>
      http.post<T.Edd>(`/clients/${enc(id)}/signoff`, body),
    review: (id: string, body: { dueOn?: string; completed?: boolean; note?: string }) => http.post<unknown>(`/clients/${enc(id)}/review`, body),
    graph: (id: string, asOf?: string, depth = 6) => http.get<T.GraphPayload>(`/clients/${enc(id)}/graph`, { asOf, depth }),
    ubo: (id: string, asOf?: string) => http.get<T.UboResult>(`/clients/${enc(id)}/ubo`, { asOf }),
    diff: (id: string, from: string, to: string) => http.get<T.GraphDiff>(`/clients/${enc(id)}/graph/diff`, { from, to }),
    holds: (id: string) => http.get<T.HoldList>(`/clients/${enc(id)}/holds`),
    placeHold: (id: string, note: string) => http.post<{ id: string; active: boolean }>(`/clients/${enc(id)}/holds`, { note }),
    releaseHolds: (id: string, note: string) => http.post<{ released: number }>(`/clients/${enc(id)}/holds/release`, { note }),
    pins: (id: string) => http.get<T.PinnedAnswer[]>(`/clients/${enc(id)}/pins`),
  },
  parties: {
    get: (id: string) => http.get<T.PartyDetail>(`/parties/${enc(id)}`),
    patch: (id: string, body: Partial<T.PartyCreate>) => http.patch<T.Party>(`/parties/${enc(id)}`, body),
    graph: (id: string, asOf?: string, depth = 2) => http.get<T.GraphPayload>(`/parties/${enc(id)}/graph`, { asOf, depth }),
    thread: (id: string, asOf?: string) => http.get<T.ThreadResult>(`/parties/${enc(id)}/thread`, { asOf }),
    split: (id: string, recordIds: string[], note: string) => http.post<T.MergeOutcome>(`/parties/${enc(id)}/split`, { recordIds, note }),
  },
  relationships: {
    create: (body: T.RelationshipCreate) => http.post<T.Relationship>("/relationships", body),
    patch: (id: string, body: Partial<T.RelationshipCreate>) => http.patch<T.Relationship>(`/relationships/${enc(id)}`, body),
  },
  graph: {
    connection: (from: string, to: string, asOf?: string) => http.get<T.ConnectionResult>("/graph/connection", { from, to, asOf }),
    search: (q: string, limit = 10) => http.get<T.GraphNode[]>("/graph/search", { q, limit }),
    clusters: (kind?: string) => http.get<T.Cluster[]>("/graph/clusters", { kind }),
    constellation: () => http.get<T.GraphPayload>("/graph/constellation"),
  },
  resolution: {
    candidates: (q: { status?: string; band?: string; clientId?: string; page?: number; pageSize?: number } = {}) =>
      http.get<T.Page<T.MatchCandidate>>("/resolution/candidates", { status: "pending", ...q }),
    candidate: (id: string) => http.get<T.MatchCandidate>(`/resolution/candidates/${enc(id)}`),
    decide: (id: string, decision: "merge" | "not_match" | "defer", note: string) =>
      http.post<T.MergeOutcome>(`/resolution/candidates/${enc(id)}/decision`, { decision, note }),
    propose: (leftId: string, rightId: string) => http.post<T.MatchCandidate>("/resolution/propose", { leftId, rightId }),
    thresholds: () => http.get<T.Thresholds>("/resolution/thresholds"),
    stats: () => http.get<{ pending: number; autoMergedLast30d: number; decidedLast30d: number; reviewRate: number }>("/resolution/stats"),
  },
  screening: {
    hits: (q: { status?: string; clientId?: string; list?: string; page?: number; pageSize?: number } = {}) =>
      http.get<T.Page<T.ScreeningHit>>("/screening/hits", { status: "pending", ...q }),
    hit: (id: string) => http.get<T.ScreeningHit>(`/screening/hits/${enc(id)}`),
    review: (id: string, decision: "true_match" | "false_positive" | "escalate", reason: string) =>
      http.post<T.ScreeningHit>(`/screening/hits/${enc(id)}/review`, { decision, reason }),
    lists: () => http.get<T.ScreeningList[]>("/screening/lists"),
    rescreen: () => http.post<T.Job>("/screening/rescreen"),
  },
  risk: {
    methodology: () => http.get<T.Methodology[]>("/risk/methodology"),
    publish: (id: string) => http.post<T.Methodology>(`/risk/methodology/${enc(id)}/publish`),
    disagreements: (status = "open") => http.get<T.Page<T.Disagreement>>("/risk/disagreements", { status, pageSize: 50 }),
    resolveDisagreement: (id: string, outcome: "keep_rules" | "override_to_challenger" | "methodology_issue", note: string) =>
      http.post<T.Disagreement>(`/risk/disagreements/${enc(id)}/resolve`, { outcome, note }),
    models: () => http.get<T.ModelEntry[]>("/models"),
    promote: (name: string, version: string, note: string) => http.post<T.ModelEntry>(`/models/${enc(name)}/promote`, { version, note }),
    signoffs: (stage?: string) => http.get<{ clientId: string; clientName: string; rating: T.Rating; triggers: string[]; waitingSince: string }[]>("/signoffs", { stage }),
  },
  monitoring: {
    alerts: (q: { status?: string; kind?: string; clientId?: string; page?: number; pageSize?: number } = {}) =>
      http.get<T.Page<T.Alert>>("/monitoring/alerts", { status: "open", ...q }),
    alert: (id: string) => http.get<T.Alert>(`/monitoring/alerts/${enc(id)}`),
    resolve: (id: string, outcome: "resolved" | "dismissed", note: string) => http.post<T.Alert>(`/monitoring/alerts/${enc(id)}/resolve`, { outcome, note }),
    reviews: (dueBefore?: string) => http.get<T.ReviewDue[]>("/monitoring/reviews", { dueBefore }),
  },
  concerns: {
    raise: (body: { clientId?: string; summary: string; details: string }) => http.post<{ id: string; receivedAt: string; message: string }>("/concerns", body),
    triage: () => http.get<T.Concern[]>("/concerns"),
  },
  cases: {
    list: () => http.get<T.Page<T.Case>>("/cases"),
    create: (body: { clientId: string; title: string; grounds: string; concernIds?: string[] }) => http.post<T.Case>("/cases", body),
    get: (id: string) => http.get<T.Case>(`/cases/${enc(id)}`),
    patch: (id: string, body: Partial<Pick<T.Case, "title" | "grounds" | "status">>) => http.patch<T.Case>(`/cases/${enc(id)}`, body),
    smr: (id: string) => http.get<T.SmrDraft>(`/cases/${enc(id)}/smr`),
    saveSmr: (id: string, d: T.SmrDraft) =>
      http.put<T.SmrDraft>(`/cases/${enc(id)}/smr`, {
        version: d.version,
        suspicionGrounds: d.suspicionGrounds,
        subjects: d.subjects.map((s) => ({ partyId: s.partyId, role: s.role })),
        transactions: d.transactions,
        narrative: d.narrative,
        attachments: d.attachments,
      }),
    submit: (id: string) => http.post<{ reference: string; submittedAt: string }>(`/cases/${enc(id)}/smr/submit`),
    timeline: (id: string) => http.get<T.CaseTimelineEntry[]>(`/cases/${enc(id)}/timeline`),
  },
  assistant: {
    ask: (question: string, clientId?: string, asOf?: string) => http.post<T.AssistantAnswer>("/assistant/ask", { question, clientId, asOf }),
    history: (clientId?: string) => http.get<T.AssistantAnswer[]>("/assistant/history", { clientId }),
    suggestions: (clientId?: string) => http.get<string[]>("/assistant/suggestions", { clientId }),
    pin: (answerId: string, clientId: string) => http.post<{ answerId: string; clientId: string; pinnedAt: string }>(`/assistant/answers/${enc(answerId)}/pin`, { clientId }),
  },
  audit: {
    list: (q: { action?: string; actorId?: string; resourceType?: string; resourceId?: string; from?: string; to?: string; page?: number; pageSize?: number } = {}) =>
      http.get<T.Page<T.AuditEntry>>("/audit", q),
    verify: () => http.get<T.AuditVerify>("/audit/verify"),
  },
  jobs: { get: (id: string) => http.get<T.Job>(`/jobs/${enc(id)}`) },
};

export type Api = typeof api;
