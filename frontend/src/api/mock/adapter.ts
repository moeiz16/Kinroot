// Offline fixture adapter: answers /api/v1 requests in the browser with the Harbourline seed, following
// docs/API_CONTRACT.md (status codes, problem+json, pagination, permissions, tipping-off 404s).
// Used only when VITE_API_MOCK=1 (development without the API) and in tests. The real API is the default.
import { daysFromToday, today } from "../../lib/dates";
import { permissionsFor, ROLE_LABELS } from "../../lib/permissions";
import type * as T from "../types";
import {
  beneficialOwners,
  clientGraph,
  clusters,
  connection,
  constellation,
  graphDiff,
  partyGraph,
  pullThread,
  search,
  structure,
  type WorldGraph,
} from "./graphcalc";
import { buildWorld, memberView, ORGS, seal, USERS, userById, type World } from "./world";

interface Session {
  userId: string;
  orgId: string;
}
interface Ctx {
  session: Session | null;
  world: World;
  role: T.Role | null;
  perms: Set<string>;
  query: URLSearchParams;
  body: Record<string, unknown>;
  params: string[];
}
class Problem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly title: string,
    readonly detail?: string,
    readonly errors?: { field: string; message: string }[],
  ) {
    super(title);
  }
}
const notFound = () => new Problem(404, "not_found", "Not found", "This page isn't available to you.");
const forbidden = () => new Problem(403, "forbidden", "Forbidden", "You don't have permission to do that.");
const invalid = (field: string, message: string) => new Problem(422, "validation_error", "Validation failed", "One or more fields are invalid.", [{ field, message }]);

const SESSION_KEY = "kinroot.mock.session";
const worlds = new Map<string, World>();
let session: Session | null = null;
let loginFailures: Record<string, number> = {};
const verifiedParties = new Set<string>();

function storage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}
function loadSession(): Session | null {
  if (session) return session;
  try {
    const raw = storage()?.getItem(SESSION_KEY);
    session = raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    session = null;
  }
  return session;
}
function saveSession(s: Session | null) {
  session = s;
  try {
    if (s) storage()?.setItem(SESSION_KEY, JSON.stringify(s));
    else storage()?.removeItem(SESSION_KEY);
  } catch {
    /* private mode: the session lives in memory only */
  }
}
export function resetMock(): void {
  worlds.clear();
  saveSession(null);
  loginFailures = {};
}
function world(orgId: string): World {
  let w = worlds.get(orgId);
  if (!w) {
    w = buildWorld(orgId);
    worlds.set(orgId, w);
  }
  return w;
}

function roleIn(w: World, userId: string): T.Role | null {
  return w.members.find((m) => m.userId === userId)?.role ?? null;
}
function orgsFor(userId: string): T.OrgSummary[] {
  return ORGS.flatMap((o) => {
    const r = roleIn(world(o.id), userId);
    return r ? [{ id: o.id, name: o.name, slug: o.slug, country: o.country, role: r, roleLabel: ROLE_LABELS[r] }] : [];
  });
}
function me(s: Session): T.Me {
  const u = userById(s.userId);
  const w = world(s.orgId);
  const role = roleIn(w, s.userId)!;
  const now = Date.now();
  return {
    user: { id: u.id, email: u.email, fullName: u.fullName, avatarColor: u.avatarColor, createdAt: u.createdAt },
    activeOrg: w.org,
    membership: { role, roleLabel: ROLE_LABELS[role], permissions: permissionsFor(role) },
    orgs: orgsFor(u.id),
    session: { expiresAt: new Date(now + 30 * 60_000).toISOString(), absoluteExpiresAt: new Date(now + 12 * 3600_000).toISOString() },
  };
}

function need(ctx: Ctx, perm: string) {
  if (!ctx.session) throw new Problem(401, "not_authenticated", "Sign in required");
  if (!ctx.perms.has(perm)) throw forbidden();
}
function paged<V>(items: V[], q: URLSearchParams): T.Page<V> {
  const page = Math.max(1, Number(q.get("page") ?? 1));
  const pageSize = Math.min(200, Math.max(1, Number(q.get("pageSize") ?? 25)));
  const total = items.length;
  return { items: items.slice((page - 1) * pageSize, page * pageSize), page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}
function audit(w: World, actorName: string, action: string, label: string, resourceType: string | null, resourceId: string | null, metadata: Record<string, unknown> = {}) {
  const prev = w.audit[w.audit.length - 1]?.hash ?? "0".repeat(64);
  const createdAt = new Date().toISOString();
  w.audit.push({ id: w.audit.length + 1, action, label, actorName, actorType: "user", resourceType, resourceId, metadata, ip: "203.0.113.20", createdAt, prevHash: prev, hash: seal(prev, `${action}|${label}|${createdAt}`) });
}
function actorName(ctx: Ctx) {
  return ctx.session ? userById(ctx.session.userId).fullName : "System";
}
function clientById(w: World, id: string): T.Client {
  const c = w.clients.find((x) => x.id === id);
  if (!c) throw notFound();
  return withStructure(w, c);
}
function withStructure(w: WorldGraph, c: T.Client): T.Client {
  const s = structure(w, c.partyId, today());
  const ubo = beneficialOwners(w, c, today());
  const layers = Math.max(0, ...[...s.levels.entries()].filter(([id]) => w.parties[id]?.kind === "person").map(([, l]) => l));
  return { ...c, structure: { parties: s.levels.size, layers, ubos: ubo.owners.filter((o) => o.isUbo).length } };
}
function canSeeCase(ctx: Ctx, cs: World["cases"][number]): "full" | "summary" | null {
  if (!ctx.session) return null;
  if (ctx.role === "compliance_officer") return "full";
  return cs.access.find((a) => a.userId === ctx.session!.userId)?.level ?? null;
}
function caseView(ctx: Ctx, cs: World["cases"][number]): T.Case {
  const level = canSeeCase(ctx, cs);
  if (!level) throw notFound();
  if (level === "summary") {
    const { access: _a, ...rest } = cs;
    void _a;
    return { ...rest, grounds: null, accessLevel: "summary", redactedFields: ["grounds", "narrative", "transactions"] };
  }
  return { ...cs, accessLevel: "full", redactedFields: [] };
}

type Handler = (ctx: Ctx) => unknown;
const routes: [string, RegExp, Handler][] = [];
const on = (method: string, path: string, h: Handler) => routes.push([method, new RegExp("^" + path.replace(/:\w+/g, "([^/]+)") + "$"), h]);

// ------------------------------------------------------------------ auth
on("GET", "/auth/csrf", () => {
  if (typeof document !== "undefined") document.cookie = "kr_csrf=offline-csrf-token; path=/";
  return undefined;
});
on("GET", "/auth/me", (ctx) => {
  if (!ctx.session) throw new Problem(401, "not_authenticated", "Sign in required");
  return me(ctx.session);
});
on("POST", "/auth/login", (ctx) => {
  const email = String(ctx.body.email ?? "").trim().toLowerCase();
  if ((loginFailures[email] ?? 0) >= 5) throw new Problem(429, "rate_limited", "Too many attempts", "Too many attempts. Try again in 15 minutes.");
  const u = USERS.find((x) => x.email === email);
  if (!u || u.password !== ctx.body.password) {
    loginFailures[email] = (loginFailures[email] ?? 0) + 1;
    throw new Problem(401, "invalid_credentials", "Sign-in failed", `That email and password don't match. ${Math.max(0, 5 - loginFailures[email]!)} tries left before a 15-minute pause.`);
  }
  loginFailures[email] = 0;
  const org = orgsFor(u.id)[0]!;
  saveSession({ userId: u.id, orgId: org.id });
  audit(world(org.id), u.fullName, "auth.login", "Signed in", null, null);
  return me(session!);
});
on("POST", "/auth/signup", (ctx) => {
  const b = ctx.body as unknown as T.SignupBody;
  if (!b.email?.includes("@")) throw invalid("email", "Enter an email address.");
  if (USERS.some((u) => u.email === b.email.toLowerCase())) throw invalid("email", "An account with this email already exists. Sign in instead.");
  if ((b.password ?? "").length < 12) throw new Problem(422, "weak_password", "Weak password", "Use at least 12 characters.", [{ field: "password", message: "Use at least 12 characters." }]);
  if (!b.fullName?.trim()) throw invalid("fullName", "Enter your name.");
  if (!b.firmName?.trim()) throw invalid("firmName", "Enter your firm's name.");
  const id = `u-${USERS.length + 1}`;
  USERS.push({ id, email: b.email.toLowerCase(), fullName: b.fullName, avatarColor: "#3A4146", createdAt: new Date().toISOString(), password: b.password });
  const orgId = `org-${b.firmName.toLowerCase().replace(/[^a-z]+/g, "-")}`;
  ORGS.push({ ...ORGS[0]!, id: orgId, name: b.firmName, slug: orgId.slice(4), country: b.country, regime: b.country === "GB" ? { name: "UK MLR 2017", commencement: null } : ORGS[0]!.regime, dataResidency: b.country === "GB" ? "UK" : "AU" });
  const w: World = { ...buildWorld("org-northgate"), org: ORGS[ORGS.length - 1]!, clients: [], parties: {}, rels: [], members: [{ userId: id, orgId, role: "owner", joinedAt: new Date().toISOString() }], audit: [] };
  worlds.set(orgId, w);
  saveSession({ userId: id, orgId });
  return me(session!);
});
on("POST", "/auth/logout", () => {
  saveSession(null);
  return undefined;
});
on("POST", "/auth/refresh", (ctx) => {
  if (!ctx.session) throw new Problem(401, "session_expired", "Session expired");
  return me(ctx.session).session;
});
on("POST", "/auth/switch-org", (ctx) => {
  if (!ctx.session) throw new Problem(401, "not_authenticated", "Sign in required");
  const orgId = String(ctx.body.orgId);
  if (!orgsFor(ctx.session.userId).some((o) => o.id === orgId)) throw notFound();
  saveSession({ ...ctx.session, orgId });
  return me(session!);
});
on("POST", "/auth/password", (ctx) => {
  if (!ctx.session) throw new Problem(401, "not_authenticated", "Sign in required");
  const u = userById(ctx.session.userId);
  if (u.password !== ctx.body.currentPassword) throw invalid("currentPassword", "That isn't your current password.");
  if (String(ctx.body.newPassword ?? "").length < 12) throw new Problem(422, "weak_password", "Weak password", "Use at least 12 characters.", [{ field: "newPassword", message: "Use at least 12 characters." }]);
  u.password = String(ctx.body.newPassword);
  return undefined;
});

// ------------------------------------------------------------------ org, members, invitations, settings
on("GET", "/org", (ctx) => (need(ctx, "dashboard:read"), ctx.world.org));
on("PATCH", "/org", (ctx) => {
  need(ctx, "org:admin");
  Object.assign(ctx.world.org, ctx.body);
  audit(ctx.world, actorName(ctx), "org.updated", "Updated the firm's details", "org", ctx.world.org.id);
  return ctx.world.org;
});
on("GET", "/org/members", (ctx) => (need(ctx, "dashboard:read"), ctx.world.members.map((m) => memberView(ctx.world, m))));
on("PATCH", "/org/members/:id", (ctx) => {
  need(ctx, "members:manage");
  const m = ctx.world.members.find((x) => `mem-${x.userId}` === ctx.params[0]);
  if (!m) throw notFound();
  const role = ctx.body.role as T.Role;
  if (m.role === "owner" && role !== "owner" && ctx.world.members.filter((x) => x.role === "owner").length === 1) throw new Problem(409, "conflict", "Conflict", "A firm needs at least one administrator.");
  m.role = role;
  audit(ctx.world, actorName(ctx), "member.role_changed", `Changed ${userById(m.userId).fullName}'s role to ${ROLE_LABELS[role]}`, "member", m.userId);
  return memberView(ctx.world, m);
});
on("DELETE", "/org/members/:id", (ctx) => {
  need(ctx, "members:manage");
  const i = ctx.world.members.findIndex((x) => `mem-${x.userId}` === ctx.params[0]);
  if (i < 0) throw notFound();
  if (ctx.world.members[i]!.role === "owner" && ctx.world.members.filter((x) => x.role === "owner").length === 1) throw new Problem(409, "conflict", "Conflict", "A firm needs at least one administrator.");
  ctx.world.members.splice(i, 1);
  return undefined;
});
on("GET", "/org/invitations", (ctx) => (need(ctx, "members:manage"), ctx.world.invitations.filter((i) => !i.acceptedAt).map(({ token: _t, ...i }) => (void _t, i))));
on("POST", "/org/invitations", (ctx) => {
  need(ctx, "members:manage");
  const email = String(ctx.body.email ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw invalid("email", "Enter an email address.");
  const token = `inv-${Math.random().toString(36).slice(2, 10)}`;
  const inv = { id: `inv-${ctx.world.invitations.length + 2}`, token, email, role: ctx.body.role as T.Role, roleLabel: ROLE_LABELS[ctx.body.role as T.Role], expiresAt: new Date(Date.now() + 7 * 864e5).toISOString(), acceptedAt: null, createdAt: new Date().toISOString() };
  ctx.world.invitations.push(inv);
  audit(ctx.world, actorName(ctx), "invitation.created", `Invited ${email} as ${ROLE_LABELS[inv.role]}`, "invitation", inv.id);
  const { token: _t, ...invitation } = inv;
  void _t;
  return { invitation, inviteUrl: `${typeof location !== "undefined" ? location.origin : ""}/invite/${token}` };
});
on("DELETE", "/org/invitations/:id", (ctx) => {
  need(ctx, "members:manage");
  ctx.world.invitations = ctx.world.invitations.filter((i) => i.id !== ctx.params[0]);
  return undefined;
});
function findInvitation(token: string) {
  for (const o of ORGS) {
    const inv = world(o.id).invitations.find((i) => i.token === token && !i.acceptedAt);
    if (inv) return { inv, w: world(o.id) };
  }
  throw notFound();
}
on("GET", "/invitations/:token", (ctx) => {
  const { inv, w } = findInvitation(ctx.params[0]!);
  return { orgName: w.org.name, email: inv.email, role: inv.role, roleLabel: ROLE_LABELS[inv.role], expiresAt: inv.expiresAt };
});
on("POST", "/invitations/:token/accept", (ctx) => {
  const { inv, w } = findInvitation(ctx.params[0]!);
  let user = USERS.find((u) => u.email === inv.email);
  if (!user) {
    if (!String(ctx.body.fullName ?? "").trim()) throw invalid("fullName", "Enter your name.");
    if (String(ctx.body.password ?? "").length < 12) throw new Problem(422, "weak_password", "Weak password", "Use at least 12 characters.", [{ field: "password", message: "Use at least 12 characters." }]);
    user = { id: `u-${USERS.length + 1}`, email: inv.email, fullName: String(ctx.body.fullName), avatarColor: "#586064", createdAt: new Date().toISOString(), password: String(ctx.body.password) };
    USERS.push(user);
  }
  inv.acceptedAt = new Date().toISOString();
  w.members.push({ userId: user.id, orgId: w.org.id, role: inv.role, joinedAt: inv.acceptedAt });
  saveSession({ userId: user.id, orgId: w.org.id });
  audit(w, user.fullName, "invitation.accepted", `${user.fullName} joined as ${ROLE_LABELS[inv.role]}`, "member", user.id);
  return me(session!);
});
on("GET", "/settings", (ctx) => (need(ctx, "dashboard:read"), ctx.world.settings));
on("PATCH", "/settings", (ctx) => {
  const b = ctx.body as Partial<T.OrgSettings>;
  if (b.retention) {
    need(ctx, "retention:manage");
    const min = ctx.world.org.country === "GB" ? 5 : 7;
    if (b.retention.years < min) throw invalid("retention.years", `Records must be kept for at least ${min} years.`);
  } else if (!ctx.perms.has("org:admin") && !ctx.perms.has("methodology:manage")) throw forbidden();
  Object.assign(ctx.world.settings, b);
  audit(ctx.world, actorName(ctx), "settings.updated", "Updated firm settings", "settings", null);
  return ctx.world.settings;
});
on("GET", "/settings/retention/preview", (ctx) => {
  need(ctx, "retention:manage");
  const items = ctx.world.clients
    .filter((c) => c.status === "exited")
    .map((c) => ({ recordType: "client" as const, id: c.id, label: c.name, relationshipEndedOn: daysFromToday(-730), disposableFrom: daysFromToday(-730 + ctx.world.settings.retention.years * 365), legalHold: ctx.world.settings.retention.legalHoldClientIds.includes(c.id) }));
  return { asOf: today(), dueCount: 0, items };
});
on("POST", "/settings/retention/run", (ctx) => (need(ctx, "retention:manage"), { id: "job-retention", kind: "retention.run", status: "succeeded", progress: 100, result: { dryRun: true, disposed: 0 }, createdAt: new Date().toISOString() }));
on("GET", "/training", (ctx) => (need(ctx, "training:read"), ctx.world.training));

// ------------------------------------------------------------------ dashboard
on("GET", "/dashboard", (ctx) => {
  need(ctx, "dashboard:read");
  const w = ctx.world;
  const p = ctx.perms;
  const tray: T.TrayItem[] = [];
  const pendingHits = w.hits.filter((h) => h.status === "pending");
  const pendingMatches = w.candidates.filter((c) => c.status === "pending");
  const reviews = w.clients.filter((c) => c.nextReviewOn && c.nextReviewOn <= daysFromToday(30) && c.status === "active");
  const mine = (c: T.Client) => c.assignedTo?.id === ctx.session!.userId;
  if (p.has("signoff:compliance"))
    w.clients.filter((c) => w.edd[c.id]?.status === "awaiting_compliance").slice(0, 1).forEach((c) => tray.push({ kind: "signoff", id: `so-${c.id}`, clientId: c.id, title: `Sign off: ${c.name}`, subtitle: "Enhanced checks complete", dueOn: null, href: `/clients/${c.id}/risk` }));
  if (p.has("signoff:senior"))
    w.clients.filter((c) => w.edd[c.id]?.status === "awaiting_senior").forEach((c) => tray.push({ kind: "signoff", id: `so-${c.id}`, clientId: c.id, title: `Approve: ${c.name}`, subtitle: "Senior approval · PEP in structure", dueOn: null, href: `/clients/${c.id}/risk` }));
  if (p.has("screening:review")) pendingHits.slice(0, 2).forEach((h) => tray.push({ kind: "hit_review", id: h.id, clientId: h.clientId, title: `Match: ${h.partyName}`, subtitle: `${Math.round(h.score * 100)} in 100 · ${h.entry.listKind === "sanctions" ? "sanctions list" : "PEP list"}`, dueOn: null, href: `/screening/${h.id}` }));
  if (p.has("resolution:decide")) pendingMatches.slice(0, 1).forEach((m) => tray.push({ kind: "merge_review", id: m.id, clientId: m.clientIds[0] ?? null, title: `Duplicate: ${m.left.name} ×2`, subtitle: `${Math.round(m.score.probability * 100)} in 100 · person`, dueOn: null, href: `/fuse/${m.id}` }));
  if (p.has("risk:override")) w.assessments.filter((a) => a.challenger?.agreement === "disagree").slice(0, 1).forEach((a) => tray.push({ kind: "disagreement", id: a.challenger!.disagreementId!, clientId: a.clientId, title: `Second opinion differs: ${w.clients.find((c) => c.id === a.clientId)!.name}`, subtitle: `Rules ${a.rating} · second opinion ${a.challenger!.rating}`, dueOn: null, href: `/clients/${a.clientId}/risk` }));
  w.alerts.filter((a) => a.status === "open" && (p.has("monitoring:manage") || p.has("signoff:senior") || mine(w.clients.find((c) => c.id === a.clientId)!))).slice(0, 2).forEach((a) => tray.push({ kind: "alert", id: a.id, clientId: a.clientId, title: `Alert: ${a.clientName.replace(/ Pty Ltd$/, "")}`, subtitle: a.title, dueOn: null, href: `/alerts/${a.id}` }));
  reviews.filter((c) => p.has("monitoring:manage") || mine(c) || p.has("signoff:senior")).slice(0, 2).forEach((c) => tray.push({ kind: "review_due", id: `rv-${c.id}`, clientId: c.id, title: `Review: ${c.name}`, subtitle: c.nextReviewOn! < today() ? "Overdue" : "Due soon", dueOn: c.nextReviewOn, href: `/clients/${c.id}/summary` }));
  const ratingMix = { low: 0, medium: 0, high: 0 };
  w.clients.filter((c) => c.status === "active").forEach((c) => c.rating && ratingMix[c.rating]++);
  const commencement = w.org.regime.commencement;
  const counts: T.Dashboard["counts"] = {
    clients: w.clients.filter((c) => c.status !== "exited").length,
    highRisk: ratingMix.high,
    reviewsOverdue: w.clients.filter((c) => c.nextReviewOn && c.nextReviewOn < today()).length,
    reviewsDueSoon: reviews.filter((c) => c.nextReviewOn! >= today()).length,
    screeningBacklog: pendingHits.length,
    openAlerts: w.alerts.filter((a) => a.status === "open").length,
    eddInProgress: Object.values(w.edd).filter((e) => e.status === "in_progress" && e.required).length,
    awaitingSignoff: Object.values(w.edd).filter((e) => e.status.startsWith("awaiting")).length,
    trainingOverdue: w.training.filter((t) => t.status === "overdue").length,
  };
  if (p.has("resolution:read")) counts.mergeQueue = pendingMatches.length;
  if (p.has("smr:read")) counts.smrDrafts = w.cases.filter((c) => c.smrStatus === "draft").length;
  return {
    fileTray: tray.slice(0, 6),
    counts,
    ratingMix,
    regime: { name: w.org.regime.name, commencement, daysToCommencement: commencement ? Math.ceil((new Date(commencement).getTime() - Date.now()) / 864e5) : null },
    recentActivity: w.audit
      .filter((a) => !a.metadata.restricted || p.has("smr:read"))
      .slice(-5)
      .reverse()
      .map((a) => ({ id: a.id, action: a.action, label: a.label, actorName: a.actorName, createdAt: a.createdAt })),
  } satisfies T.Dashboard;
});
on("GET", "/insights", (ctx) => (need(ctx, "insights:read"), ctx.world.insights));

// ------------------------------------------------------------------ clients
on("GET", "/clients", (ctx) => {
  need(ctx, "clients:read");
  const q = ctx.query;
  let list = ctx.world.clients.map((c) => withStructure(ctx.world, c));
  const needle = q.get("q")?.toLowerCase();
  if (needle) list = list.filter((c) => c.name.toLowerCase().includes(needle));
  if (q.get("kind")) list = list.filter((c) => c.kind === q.get("kind"));
  if (q.get("rating")) list = list.filter((c) => c.rating === q.get("rating"));
  if (q.get("status")) list = list.filter((c) => c.status === q.get("status"));
  if (q.get("reviewDue") === "true") list = list.filter((c) => c.nextReviewOn && c.nextReviewOn <= daysFromToday(30));
  if (q.get("assignedTo") === "me") list = list.filter((c) => c.assignedTo?.id === ctx.session!.userId);
  list.sort((a, b) => a.name.localeCompare(b.name));
  return paged(list, q);
});
on("POST", "/clients", (ctx) => {
  need(ctx, "clients:onboard");
  const b = ctx.body as unknown as T.ClientCreate;
  if (!b.name?.trim()) throw invalid("name", "Enter the client's name.");
  const w = ctx.world;
  const id = `c-new-${w.clients.length + 1}`;
  const partyId = `p-new-${Object.keys(w.parties).length + 1}`;
  const pkind: T.PartyKind = b.kind === "individual" ? "person" : b.kind;
  w.parties[partyId] = { id: partyId, kind: pkind, name: b.name.trim(), jurisdiction: b.jurisdiction, identifiers: b.identifiers ?? {}, birthDate: b.person?.birthDate, nationality: b.person?.nationality, address: b.person?.address, isNominee: false, source: "manual", mergedInto: null, createdAt: new Date().toISOString(), flags: [] };
  const u = userById(ctx.session!.userId);
  const c: T.Client = { id, kind: b.kind, name: b.name.trim(), status: "onboarding", jurisdiction: b.jurisdiction, partyId, services: b.services, channel: b.channel, matterReference: b.matterReference ?? null, assignedTo: { id: u.id, fullName: u.fullName }, rating: null, ratingSource: null, eddRequired: false, nextReviewOn: null, lastReviewedOn: null, onboardedOn: null, structure: { parties: 1, layers: 0, ubos: 0 }, flags: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  w.clients.push(c);
  w.documents[id] = [];
  w.edd[id] = { clientId: id, required: false, triggers: [], measures: [], signoffs: [], status: "in_progress" };
  audit(w, u.fullName, "client.created", `Opened a file for ${c.name}`, "client", id);
  return c;
});
on("GET", "/clients/:id", (ctx) => (need(ctx, "clients:read"), clientById(ctx.world, ctx.params[0]!)));
on("PATCH", "/clients/:id", (ctx) => {
  need(ctx, "clients:write");
  const c = ctx.world.clients.find((x) => x.id === ctx.params[0]);
  if (!c) throw notFound();
  Object.assign(c, ctx.body);
  return clientById(ctx.world, c.id);
});
on("GET", "/clients/:id/parties", (ctx) => {
  need(ctx, "clients:read");
  const c = clientById(ctx.world, ctx.params[0]!);
  return [...structure(ctx.world, c.partyId, today()).levels.keys()].map((id) => partyView(ctx.world, id));
});
function partyView(w: World, id: string): T.Party {
  const p = w.parties[id];
  if (!p || p.kind === "stack") throw notFound();
  const { flags: _f, count: _c, sub: _s, ...rest } = p;
  void _f;
  void _c;
  void _s;
  return { ...rest, kind: p.kind } as T.Party;
}
on("POST", "/clients/:id/parties", (ctx) => {
  need(ctx, "graph:write");
  clientById(ctx.world, ctx.params[0]!);
  const b = ctx.body as unknown as T.PartyCreate;
  if (!b.name?.trim()) throw invalid("name", "Enter a name.");
  const id = `p-new-${Object.keys(ctx.world.parties).length + 1}`;
  ctx.world.parties[id] = { id, kind: b.kind, name: b.name.trim(), birthDate: b.birthDate, nationality: b.nationality, jurisdiction: b.jurisdiction, identifiers: b.identifiers ?? {}, address: b.address, isNominee: !!b.isNominee, source: "manual", mergedInto: null, createdAt: new Date().toISOString(), flags: [] };
  return partyView(ctx.world, id);
});
on("GET", "/parties/:id", (ctx) => {
  need(ctx, "clients:read");
  const w = ctx.world;
  const p = partyView(w, ctx.params[0]!);
  const merged = Object.values(w.parties).filter((x) => x.mergedInto === p.id || x.id === p.id);
  const clients = w.clients.filter((c) => structure(w, c.partyId, today()).levels.has(p.id)).map((c) => ({ id: c.id, name: c.name }));
  return { ...p, sourceRecords: merged.map((x) => ({ id: x.id, kind: (x.kind === "stack" ? "company" : x.kind) as T.PartyKind, name: x.name, birthDate: x.birthDate, nationality: x.nationality, jurisdiction: x.jurisdiction, identifiers: x.identifiers, address: x.address, source: x.source })), clients } satisfies T.PartyDetail;
});
on("PATCH", "/parties/:id", (ctx) => {
  need(ctx, "graph:write");
  const p = ctx.world.parties[ctx.params[0]!];
  if (!p) throw notFound();
  Object.assign(p, ctx.body);
  return partyView(ctx.world, p.id);
});
on("POST", "/relationships", (ctx) => {
  need(ctx, "graph:write");
  const b = ctx.body as unknown as T.RelationshipCreate;
  const w = ctx.world;
  if (!w.parties[b.fromPartyId] || !w.parties[b.toPartyId]) throw notFound();
  if (b.fromPartyId === b.toPartyId) throw invalid("toPartyId", "A party cannot own itself.");
  if (b.kind === "ownership") {
    if (b.pct == null || b.pct <= 0 || b.pct > 100) throw invalid("pct", "Enter a share between 0 and 100.");
    const held = w.rels.filter((r) => r.kind === "ownership" && r.toPartyId === b.toPartyId && r.validTo === null).reduce((a, r) => a + (r.pct ?? 0), 0);
    if (held + b.pct > 100.001) throw new Problem(422, "over_allocated", "Over-allocated", `Only ${Math.max(0, 100 - held)}% of this entity is left to allocate.`, [{ field: "pct", message: `Only ${Math.max(0, 100 - held)}% is left to allocate.` }]);
  }
  const r: T.Relationship = { id: `r-new-${w.rels.length + 1}`, fromPartyId: b.fromPartyId, toPartyId: b.toPartyId, kind: b.kind, pct: b.pct, role: b.role, interest: b.interest, nominee: !!b.nominee, validFrom: b.validFrom, validTo: b.validTo ?? null, source: "manual", sourceRef: "manual", evidenceNote: b.evidenceNote, createdAt: new Date().toISOString() };
  w.rels.push(r);
  return r;
});
on("GET", "/clients/:id/onboarding", (ctx) => {
  need(ctx, "clients:read");
  const w = ctx.world;
  const c = clientById(w, ctx.params[0]!);
  const s = structure(w, c.partyId, today());
  const people = [...s.levels.keys()].filter((id) => w.parties[id]?.kind === "person" || id === c.partyId);
  const docs = w.documents[c.id] ?? [];
  const items: T.Onboarding["items"] = [
    ...people.map((id) => ({ key: `identity_${id}`, label: `Identity: ${w.parties[id]!.name}`, done: c.status !== "onboarding" || verifiedParties.has(id) || docs.some((d) => d.partyId === id), required: true, partyId: id })),
    ...people.filter((id) => w.parties[id]!.kind === "person").map((id) => ({ key: `consent_${id}`, label: `Consent: ${w.parties[id]!.name}`, done: c.status !== "onboarding" || w.consents.some((x) => x.partyId === id), required: true, partyId: id })),
    { key: "structure_confirmed", label: "Structure confirmed", done: s.levels.size > 1 || c.kind === "individual", required: true },
    { key: "ubos_identified", label: "Beneficial owners identified", done: c.kind === "individual" || beneficialOwners(w, c, today()).owners.some((o) => o.isUbo), required: true },
    { key: "screening_clear", label: "Screening run", done: c.status !== "onboarding", required: true },
    { key: "risk_assessed", label: "Risk rated", done: c.rating !== null, required: true },
    { key: "signoff", label: "Sign-off", done: c.status === "active", required: true },
  ];
  const blocking = items.filter((i) => i.required && !i.done && !["screening_clear", "risk_assessed", "signoff"].includes(i.key));
  return { clientId: c.id, status: c.status, items, canSubmit: c.status === "onboarding" && blocking.length === 0 } satisfies T.Onboarding;
});
on("GET", "/clients/:id/documents", (ctx) => (need(ctx, "clients:read"), clientById(ctx.world, ctx.params[0]!), ctx.world.documents[ctx.params[0]!] ?? []));
on("POST", "/clients/:id/documents", (ctx) => {
  need(ctx, "identity:verify");
  const c = clientById(ctx.world, ctx.params[0]!);
  const file = ctx.body.file as File | undefined;
  if (file && file.size > 10 * 1024 * 1024) throw new Problem(413, "payload_too_large", "File too large", "Files can be up to 10 MB.");
  if (file && !/\.(pdf|png|jpe?g)$/i.test(file.name)) throw new Problem(415, "unsupported_media_type", "Unsupported file", "Upload a PDF, PNG or JPG.");
  const list = (ctx.world.documents[c.id] ??= []);
  const d: T.DocumentRec = { id: `d-${c.id}-${list.length + 10}`, partyId: String(ctx.body.partyId ?? c.partyId), docType: (ctx.body.docType as T.DocType) ?? "other", fileName: file?.name ?? "document.pdf", sizeBytes: file?.size ?? 120_000, sha256: seal("upload", file?.name ?? "doc").slice(0, 64), uploadedBy: actorName(ctx), uploadedAt: new Date().toISOString(), retainUntil: daysFromToday(7 * 365) };
  list.unshift(d);
  audit(ctx.world, actorName(ctx), "document.uploaded", `Uploaded ${d.fileName} for ${c.name}`, "client", c.id);
  return d;
});
on("POST", "/clients/:id/verification", (ctx) => {
  need(ctx, "identity:verify");
  clientById(ctx.world, ctx.params[0]!);
  verifiedParties.add(String(ctx.body.partyId));
  return { id: `vc-${Date.now()}`, partyId: String(ctx.body.partyId), method: ctx.body.method as "document", result: "verified", sources: [{ name: "Document check (demo)", matched: ["name", "date of birth", "document number"] }], reference: `MOCK-DVS-${Math.floor(Math.random() * 1e6)}`, checkedAt: new Date().toISOString() } satisfies T.VerificationCheck;
});
on("POST", "/clients/:id/consent", (ctx) => {
  need(ctx, "clients:onboard");
  const c: T.Consent = { id: `cs-${ctx.world.consents.length + 1}`, partyId: String(ctx.body.partyId), purpose: ctx.body.purpose as T.Consent["purpose"], givenOn: String(ctx.body.givenOn), method: String(ctx.body.method), recordedBy: actorName(ctx) };
  ctx.world.consents.push(c);
  return c;
});
on("POST", "/clients/:id/submit", (ctx) => {
  need(ctx, "clients:onboard");
  const w = ctx.world;
  const c = w.clients.find((x) => x.id === ctx.params[0]);
  if (!c) throw notFound();
  if (c.status !== "onboarding") throw new Problem(422, "invalid_transition", "Already submitted", "This file has already been submitted.");
  const ubo = beneficialOwners(w, c, today());
  const score = Math.min(90, 12 + ubo.warnings.length * 18 + (c.channel === "remote" ? 8 : 0) + (c.kind === "trust" ? 12 : 0) + Math.max(0, structure(w, c.partyId, today()).levels.size - 3) * 4);
  const rating: T.Rating = score >= 60 ? "high" : score >= 30 ? "medium" : "low";
  c.rating = rating;
  c.ratingSource = "rules";
  c.status = "active";
  c.onboardedOn = today();
  c.lastReviewedOn = today();
  c.nextReviewOn = daysFromToday(rating === "high" ? 365 : rating === "medium" ? 730 : 1095);
  c.eddRequired = rating === "high";
  w.assessments.push({ id: `ra-${c.id}`, clientId: c.id, methodologyVersion: "KR-RM-1.0", score, rating, reasons: [{ code: "FIRST", factor: "structure", points: score, message: `${structure(w, c.partyId, today()).levels.size - 1} parties own or control the client.`, evidence: [] }], challenger: { modelVersion: "risk-challenger 2.1", probabilityHigh: score / 100, rating, agreement: "agree", reasons: [] }, eddRequired: c.eddRequired, eddTriggers: [], inputsHash: "new", assessedAt: new Date().toISOString(), override: null });
  audit(w, actorName(ctx), "client.submitted", `Submitted ${c.name} for screening and rating`, "client", c.id);
  return { client: withStructure(w, c), jobs: [] };
});
on("POST", "/clients/:id/communications", (ctx) => {
  need(ctx, "clients:write");
  const c = clientById(ctx.world, ctx.params[0]!);
  if (ctx.world.cases.some((k) => k.clientId === c.id && k.status === "open")) throw new Problem(409, "action_held", "Held", "This step needs the compliance officer's go-ahead.");
  audit(ctx.world, actorName(ctx), "communication.sent", `Requested information from ${c.name}`, "client", c.id);
  return undefined;
});
on("POST", "/clients/:id/exit", (ctx) => {
  need(ctx, "clients:write");
  const c = ctx.world.clients.find((x) => x.id === ctx.params[0]);
  if (!c) throw notFound();
  if (ctx.world.cases.some((k) => k.clientId === c.id && k.status === "open")) throw new Problem(409, "action_held", "Held", "This step needs the compliance officer's go-ahead.");
  c.status = "exited";
  return withStructure(ctx.world, c);
});
on("POST", "/clients/:id/screen", (ctx) => (need(ctx, "screening:run"), clientById(ctx.world, ctx.params[0]!), { id: `job-${Date.now()}`, kind: "screening.client", status: "succeeded", progress: 100, result: { newHits: 0 }, createdAt: new Date().toISOString() }));

// ------------------------------------------------------------------ graph
on("GET", "/clients/:id/graph", (ctx) => (need(ctx, "graph:read"), clientGraph(ctx.world, clientById(ctx.world, ctx.params[0]!), ctx.query.get("asOf") || today(), Number(ctx.query.get("depth") ?? 6))));
on("GET", "/clients/:id/ubo", (ctx) => (need(ctx, "graph:read"), beneficialOwners(ctx.world, clientById(ctx.world, ctx.params[0]!), ctx.query.get("asOf") || today(), ctx.world.settings.ubo.thresholdPct)));
on("GET", "/clients/:id/graph/diff", (ctx) => {
  need(ctx, "graph:read");
  const from = ctx.query.get("from");
  const to = ctx.query.get("to") || today();
  if (!from) throw invalid("from", "Choose a date to compare with.");
  return graphDiff(ctx.world, clientById(ctx.world, ctx.params[0]!), from, to);
});
on("GET", "/parties/:id/graph", (ctx) => {
  need(ctx, "graph:read");
  if (!ctx.world.parties[ctx.params[0]!]) throw notFound();
  return partyGraph(ctx.world, ctx.params[0]!, ctx.query.get("asOf") || today(), Number(ctx.query.get("depth") ?? 2));
});
on("GET", "/parties/:id/thread", (ctx) => {
  need(ctx, "graph:read");
  if (!ctx.world.parties[ctx.params[0]!]) throw notFound();
  return pullThread(ctx.world, ctx.params[0]!, ctx.query.get("asOf") || today());
});
on("GET", "/graph/connection", (ctx) => (need(ctx, "graph:read"), connection(ctx.world, ctx.query.get("from") ?? "", ctx.query.get("to") ?? "", ctx.query.get("asOf") || today())));
on("GET", "/graph/search", (ctx) => (need(ctx, "graph:read"), search(ctx.world, ctx.query.get("q") ?? "", Number(ctx.query.get("limit") ?? 10))));
on("GET", "/graph/clusters", (ctx) => (need(ctx, "graph:read"), clusters(ctx.world, today(), ctx.query.get("kind") ?? undefined)));
on("GET", "/graph/constellation", (ctx) => (need(ctx, "graph:read"), constellation(ctx.world, today())));
on("GET", "/graph/status", (ctx) => (need(ctx, "graph:read"), { graphVersion: 418, pending: 0, lastAppliedAt: new Date().toISOString() }));

// ------------------------------------------------------------------ resolution
on("GET", "/resolution/candidates", (ctx) => {
  need(ctx, "resolution:read");
  const status = ctx.query.get("status") ?? "pending";
  let list = ctx.world.candidates.filter((c) => status === "all" || c.status === status);
  if (ctx.query.get("band")) list = list.filter((c) => c.score.band === ctx.query.get("band"));
  if (ctx.query.get("clientId")) list = list.filter((c) => c.clientIds.includes(ctx.query.get("clientId")!));
  return paged([...list].sort((a, b) => b.score.probability - a.score.probability), ctx.query);
});
on("GET", "/resolution/candidates/:id", (ctx) => {
  need(ctx, "resolution:read");
  const c = ctx.world.candidates.find((x) => x.id === ctx.params[0]);
  if (!c) throw notFound();
  return c;
});
on("POST", "/resolution/candidates/:id/decision", (ctx) => {
  need(ctx, "resolution:decide");
  const w = ctx.world;
  const c = w.candidates.find((x) => x.id === ctx.params[0]);
  if (!c) throw notFound();
  if (c.status !== "pending") throw new Problem(409, "already_decided", "Already decided", "Someone has already decided this pair.");
  const decision = ctx.body.decision as "merge" | "not_match" | "defer";
  const note = String(ctx.body.note ?? "");
  if (decision === "not_match" && note.trim().length < 3) throw invalid("note", "Give a reason for keeping them apart.");
  c.status = decision === "merge" ? "merged" : decision === "not_match" ? "not_match" : "deferred";
  c.decidedBy = actorName(ctx);
  c.decidedAt = new Date().toISOString();
  c.note = note;
  if (decision === "merge") {
    const loser = w.parties[c.right.id]!;
    loser.mergedInto = c.left.id;
    w.rels.forEach((r) => {
      if (r.fromPartyId === loser.id) r.fromPartyId = c.left.id;
      if (r.toPartyId === loser.id) r.toPartyId = c.left.id;
    });
    audit(w, actorName(ctx), "resolution.fused", `Fused ${c.left.name} and ${c.right.name}`, "party", c.left.id);
  } else audit(w, actorName(ctx), decision === "defer" ? "resolution.deferred" : "resolution.kept_apart", `${decision === "defer" ? "Deferred" : "Kept apart"} ${c.left.name} and ${c.right.name}`, "party", c.left.id);
  return { candidateId: c.id, survivorId: c.left.id, mergedIds: decision === "merge" ? [c.right.id] : [], status: c.status } satisfies T.MergeOutcome;
});
on("POST", "/resolution/propose", (ctx) => {
  need(ctx, "graph:write");
  const w = ctx.world;
  const l = w.parties[String(ctx.body.leftId)];
  const r = w.parties[String(ctx.body.rightId)];
  if (!l || !r) throw notFound();
  const existing = w.candidates.find((c) => (c.left.id === l.id && c.right.id === r.id) || (c.left.id === r.id && c.right.id === l.id));
  if (existing) return existing;
  const same = (a?: string, b?: string) => (a && b ? (a === b ? 1 : 0) : -1);
  const prob = Math.min(0.95, 0.2 + (same(l.birthDate, r.birthDate) === 1 ? 0.45 : 0) + (l.name.split(" ").pop() === r.name.split(" ").pop() ? 0.2 : 0));
  const cand: T.MatchCandidate = { id: `m-new-${w.candidates.length + 1}`, status: "pending", left: { id: l.id, kind: l.kind === "stack" ? "company" : l.kind, name: l.name, birthDate: l.birthDate, identifiers: l.identifiers, address: l.address, source: l.source }, right: { id: r.id, kind: r.kind === "stack" ? "company" : r.kind, name: r.name, birthDate: r.birthDate, identifiers: r.identifiers, address: r.address, source: r.source }, score: { probability: prob, band: prob >= 0.4 ? "review" : "reject", fsWeight: 0, fsProbability: prob, features: {}, reasons: [{ feature: "dob_exact", label: same(l.birthDate, r.birthDate) === 1 ? "Same date of birth" : "Different dates of birth", direction: same(l.birthDate, r.birthDate) === 1 ? "for" : "against", contribution: same(l.birthDate, r.birthDate) === 1 ? 0.45 : -0.3, value: null }], modelVersion: "er-matcher 1.4" }, clientIds: [], createdAt: new Date().toISOString() };
  w.candidates.push(cand);
  return cand;
});
on("POST", "/parties/:id/split", (ctx) => {
  need(ctx, "resolution:decide");
  const w = ctx.world;
  const ids = (ctx.body.recordIds as string[]) ?? [];
  ids.forEach((id) => {
    const p = w.parties[id];
    if (p) p.mergedInto = null;
  });
  const c = w.candidates.find((x) => x.left.id === ctx.params[0] && ids.includes(x.right.id));
  if (c) c.status = "not_match";
  audit(w, actorName(ctx), "resolution.split", `Split ${w.parties[ctx.params[0]!]?.name ?? "a record"} into separate records`, "party", ctx.params[0]!);
  return { survivorId: ctx.params[0]!, mergedIds: ids, status: "split" } satisfies T.MergeOutcome;
});
on("GET", "/resolution/thresholds", (ctx) => (need(ctx, "resolution:read"), { autoMerge: 0.97, review: 0.4, modelVersion: "er-matcher 1.4", chosenBy: "Daniel Cho", expectedReviewRate: 0.12 } satisfies T.Thresholds));
on("GET", "/resolution/stats", (ctx) => (need(ctx, "resolution:read"), { pending: ctx.world.candidates.filter((c) => c.status === "pending").length, autoMergedLast30d: 1, decidedLast30d: 12, reviewRate: 0.12 }));

// ------------------------------------------------------------------ screening
on("GET", "/screening/hits", (ctx) => {
  need(ctx, "screening:read");
  const status = ctx.query.get("status") ?? "pending";
  let list = ctx.world.hits.filter((h) => status === "all" || h.status === status);
  if (ctx.query.get("clientId")) list = list.filter((h) => h.clientId === ctx.query.get("clientId"));
  if (ctx.query.get("list")) list = list.filter((h) => h.entry.listKind === ctx.query.get("list"));
  const hideReason = !ctx.perms.has("screening:review");
  return paged([...list].sort((a, b) => b.score - a.score).map((h) => (hideReason && h.status === "pending" ? { ...h, reviewReason: undefined } : h)), ctx.query);
});
on("GET", "/screening/hits/:id", (ctx) => {
  need(ctx, "screening:read");
  const h = ctx.world.hits.find((x) => x.id === ctx.params[0]);
  if (!h) throw notFound();
  return h;
});
on("POST", "/screening/hits/:id/review", (ctx) => {
  need(ctx, "screening:review");
  const w = ctx.world;
  const h = w.hits.find((x) => x.id === ctx.params[0]);
  if (!h) throw notFound();
  if (h.status !== "pending") throw new Problem(409, "already_decided", "Already decided", "This match has already been reviewed.");
  const reason = String(ctx.body.reason ?? "");
  if (reason.trim().length < 10) throw invalid("reason", "Give a reason of at least 10 characters.");
  const decision = ctx.body.decision as "true_match" | "false_positive" | "escalate";
  h.status = decision === "escalate" ? "escalated" : decision;
  h.reviewedBy = actorName(ctx);
  h.reviewedAt = new Date().toISOString();
  h.reviewReason = reason;
  if (decision === "true_match" && h.entry.listKind === "sanctions") {
    const c = w.clients.find((x) => x.id === h.clientId);
    if (c) c.status = "blocked";
  }
  audit(w, actorName(ctx), "screening.hit_reviewed", `Reviewed the ${h.entry.listKind === "pep" ? "PEP" : "sanctions"} match for ${h.partyName}: ${h.status.replace("_", " ")}`, "client", h.clientId);
  return h;
});
on("GET", "/screening/lists", (ctx) => (need(ctx, "screening:read"), [
  { list: "Sanctions (sample)", source: "Bundled sample list", version: "sample-2025.10", entries: 412, loadedAt: new Date(Date.now() - 3 * 864e5).toISOString(), sample: true },
  { list: "Politically exposed persons (sample)", source: "Bundled sample list", version: "sample-2025.10", entries: 1280, loadedAt: new Date(Date.now() - 3 * 864e5).toISOString(), sample: true },
] satisfies T.ScreeningList[]));
on("POST", "/screening/rescreen", (ctx) => (need(ctx, "monitoring:manage"), { id: "job-rescreen", kind: "screening.rescreen_org", status: "queued", progress: 0, createdAt: new Date().toISOString() }));

// ------------------------------------------------------------------ risk
on("GET", "/clients/:id/risk", (ctx) => (need(ctx, "risk:read"), clientById(ctx.world, ctx.params[0]!), ctx.world.assessments.filter((a) => a.clientId === ctx.params[0]).slice(-1)[0] ?? null));
on("GET", "/clients/:id/risk/history", (ctx) => (need(ctx, "risk:read"), ctx.world.assessments.filter((a) => a.clientId === ctx.params[0]).reverse()));
on("POST", "/clients/:id/risk/assess", (ctx) => {
  need(ctx, "risk:assess");
  const w = ctx.world;
  const prev = w.assessments.filter((a) => a.clientId === ctx.params[0]).slice(-1)[0];
  if (!prev) throw notFound();
  const next = { ...prev, id: `${prev.id}-r${Date.now() % 1000}`, assessedAt: new Date().toISOString() };
  w.assessments.push(next);
  audit(w, actorName(ctx), "risk.assessed", `Re-rated ${clientById(w, prev.clientId).name}`, "client", prev.clientId);
  return next;
});
on("POST", "/clients/:id/risk/override", (ctx) => {
  need(ctx, "risk:override");
  const w = ctx.world;
  const prev = w.assessments.filter((a) => a.clientId === ctx.params[0]).slice(-1)[0];
  if (!prev) throw notFound();
  const rating = ctx.body.rating as T.Rating;
  const reason = String(ctx.body.reason ?? "");
  const order = { low: 0, medium: 1, high: 2 };
  if (order[rating] < order[prev.rating] && reason.trim().length < 20) throw invalid("reason", "Lowering a rating needs a reason of at least 20 characters.");
  const next = { ...prev, id: `${prev.id}-o`, override: { rating, reason, byName: actorName(ctx), at: new Date().toISOString() } };
  w.assessments.push(next);
  const c = w.clients.find((x) => x.id === ctx.params[0])!;
  c.rating = rating;
  c.ratingSource = "override";
  return next;
});
on("GET", "/risk/methodology", (ctx) => (need(ctx, "risk:read"), ctx.world.methodologies));
on("POST", "/risk/methodology/:id/publish", (ctx) => {
  need(ctx, "methodology:manage");
  const m = ctx.world.methodologies.find((x) => x.id === ctx.params[0]);
  if (!m) throw notFound();
  ctx.world.methodologies.forEach((x) => x.status === "published" && (x.status = "retired"));
  m.status = "published";
  m.publishedAt = new Date().toISOString();
  m.publishedBy = actorName(ctx);
  return m;
});
on("GET", "/clients/:id/edd", (ctx) => (need(ctx, "risk:read"), clientById(ctx.world, ctx.params[0]!), ctx.world.edd[ctx.params[0]!]));
on("POST", "/clients/:id/edd/measures/:key", (ctx) => {
  need(ctx, "edd:manage");
  const e = ctx.world.edd[ctx.params[0]!];
  const m = e?.measures.find((x) => x.key === ctx.params[1]);
  if (!e || !m) throw notFound();
  m.status = ctx.body.status as "done";
  m.note = String(ctx.body.note ?? "");
  m.completedBy = actorName(ctx);
  m.completedAt = new Date().toISOString();
  if (e.measures.filter((x) => x.key !== "senior_approval").every((x) => x.status !== "todo") && e.status === "in_progress") e.status = "awaiting_compliance";
  return e;
});
on("POST", "/clients/:id/signoff", (ctx) => {
  const stage = ctx.body.stage as "compliance" | "senior";
  need(ctx, stage === "compliance" ? "signoff:compliance" : "signoff:senior");
  const w = ctx.world;
  const e = w.edd[ctx.params[0]!];
  const c = w.clients.find((x) => x.id === ctx.params[0]);
  if (!e || !c) throw notFound();
  if (stage === "compliance" && e.status !== "awaiting_compliance") throw new Problem(422, "invalid_transition", "Not ready", "The enhanced checks are not complete yet.");
  if (stage === "senior" && e.status !== "awaiting_senior") throw new Problem(422, "invalid_transition", "Not ready", "The compliance officer has not signed off yet.");
  if (stage === "senior" && c.assignedTo?.id === ctx.session!.userId) throw new Problem(422, "invalid_transition", "Conflict of interest", "A partner cannot approve their own client's file.");
  const decision = ctx.body.decision as "approve" | "reject";
  e.signoffs.push({ stage, decision, note: String(ctx.body.note ?? ""), byName: actorName(ctx), at: new Date().toISOString() });
  e.status = decision === "reject" ? "rejected" : stage === "compliance" && e.measures.some((m) => m.key === "senior_approval") ? "awaiting_senior" : "approved";
  if (e.status === "approved") e.measures.forEach((m) => m.key === "senior_approval" && (m.status = "done"));
  audit(w, actorName(ctx), "signoff." + decision, `${decision === "approve" ? "Signed off" : "Rejected"} ${c.name} (${stage === "compliance" ? "compliance" : "senior approval"})`, "client", c.id);
  return e;
});
on("GET", "/signoffs", (ctx) => {
  const stage = ctx.query.get("stage") ?? "compliance";
  need(ctx, stage === "senior" ? "signoff:senior" : "signoff:compliance");
  return ctx.world.clients.filter((c) => ctx.world.edd[c.id]?.status === `awaiting_${stage}`).map((c) => ({ clientId: c.id, clientName: c.name, rating: c.rating!, triggers: ctx.world.edd[c.id]!.triggers.map((t) => t.message), waitingSince: daysFromToday(-6) }));
});
on("GET", "/models", (ctx) => (need(ctx, "models:read"), []));

// ------------------------------------------------------------------ monitoring
on("GET", "/monitoring/alerts", (ctx) => {
  need(ctx, "monitoring:read");
  const status = ctx.query.get("status") ?? "open";
  let list = ctx.world.alerts.filter((a) => status === "all" || a.status === status);
  if (ctx.query.get("clientId")) list = list.filter((a) => a.clientId === ctx.query.get("clientId"));
  if (ctx.query.get("kind")) list = list.filter((a) => a.kind === ctx.query.get("kind"));
  const sev = { critical: 0, warning: 1, info: 2 };
  return paged([...list].sort((a, b) => sev[a.severity] - sev[b.severity] || b.createdAt.localeCompare(a.createdAt)), ctx.query);
});
on("GET", "/monitoring/alerts/:id", (ctx) => {
  need(ctx, "monitoring:read");
  const a = ctx.world.alerts.find((x) => x.id === ctx.params[0]);
  if (!a) throw notFound();
  return a;
});
on("POST", "/monitoring/alerts/:id/resolve", (ctx) => {
  need(ctx, "monitoring:manage");
  const a = ctx.world.alerts.find((x) => x.id === ctx.params[0]);
  if (!a) throw notFound();
  if (String(ctx.body.note ?? "").trim().length < 3) throw invalid("note", "Give a reason.");
  a.status = ctx.body.outcome as "resolved" | "dismissed";
  a.resolvedBy = actorName(ctx);
  a.resolvedAt = new Date().toISOString();
  a.resolutionNote = String(ctx.body.note);
  audit(ctx.world, actorName(ctx), "alert." + a.status, `${a.status === "dismissed" ? "Dismissed" : "Resolved"} alert: ${a.title}`, "client", a.clientId);
  return a;
});
on("GET", "/monitoring/reviews", (ctx) => {
  need(ctx, "monitoring:read");
  const before = ctx.query.get("dueBefore") ?? daysFromToday(60);
  return ctx.world.clients
    .filter((c) => c.status === "active" && c.nextReviewOn && c.nextReviewOn <= before)
    .map((c) => ({ clientId: c.id, clientName: c.name, rating: c.rating, lastReviewedOn: c.lastReviewedOn, nextReviewOn: c.nextReviewOn!, overdueDays: Math.max(0, Math.round((Date.now() - new Date(c.nextReviewOn!).getTime()) / 864e5)), assignedToName: c.assignedTo?.fullName ?? null }))
    .sort((a, b) => a.nextReviewOn.localeCompare(b.nextReviewOn));
});
on("POST", "/clients/:id/review", (ctx) => {
  need(ctx, "monitoring:manage");
  const c = ctx.world.clients.find((x) => x.id === ctx.params[0]);
  if (!c) throw notFound();
  if (ctx.body.completed) {
    c.lastReviewedOn = today();
    c.nextReviewOn = daysFromToday(c.rating === "high" ? 365 : c.rating === "medium" ? 730 : 1095);
    c.flags = c.flags.filter((f) => f !== "review_overdue");
    ctx.world.alerts.filter((a) => a.clientId === c.id && a.kind === "review_due").forEach((a) => (a.status = "resolved"));
  } else if (ctx.body.dueOn) c.nextReviewOn = String(ctx.body.dueOn);
  return { clientId: c.id, nextReviewOn: c.nextReviewOn };
});

// ------------------------------------------------------------------ concerns and cases (tipping-off: 404 for anyone outside the list)
on("POST", "/concerns", (ctx) => (need(ctx, "concerns:raise"), { id: `con-${Date.now()}`, receivedAt: new Date().toISOString(), message: "Received. The compliance officer will take it from here." }));
on("GET", "/concerns/mine", (ctx) => (need(ctx, "concerns:raise"), []));
on("GET", "/concerns", (ctx) => {
  need(ctx, "smr:read");
  const lumen = ctx.world.clients.find((c) => c.name.startsWith("Lumen"));
  return [{ id: "con-1", clientId: lumen?.id ?? null, clientName: lumen?.name ?? null, raisedByName: "Tom Nguyen", summary: "Director seems to be a stand-in", details: "The director defers every question to an overseas contact.", status: "received", caseId: null, receivedAt: new Date().toISOString() }];
});
const holds = new Map<string, T.HoldList["holds"]>();
on("GET", "/clients/:id/holds", (ctx) => {
  need(ctx, "signoff:compliance");
  clientById(ctx.world, ctx.params[0]!);
  const h = holds.get(ctx.params[0]!) ?? [];
  return { active: h.length > 0, holds: h };
});
on("POST", "/clients/:id/holds", (ctx) => {
  need(ctx, "signoff:compliance");
  const h = { id: `hold-${Date.now()}`, reason: "manual" as const, note: String(ctx.body.note ?? ""), placedByName: actorName(ctx), placedAt: new Date().toISOString() };
  holds.set(ctx.params[0]!, [...(holds.get(ctx.params[0]!) ?? []), h]);
  return { id: h.id, active: true };
});
on("POST", "/clients/:id/holds/release", (ctx) => {
  need(ctx, "signoff:compliance");
  const n = holds.get(ctx.params[0]!)?.length ?? 0;
  holds.delete(ctx.params[0]!);
  return { released: n };
});
const pins = new Map<string, T.PinnedAnswer[]>();
on("GET", "/clients/:id/pins", (ctx) => (need(ctx, "clients:read"), pins.get(ctx.params[0]!) ?? []));
on("POST", "/assistant/answers/:id/pin", (ctx) => {
  need(ctx, "assistant:use");
  const a = history.find((h) => h.id === ctx.params[0]);
  if (!a) throw notFound();
  const clientId = String(ctx.body.clientId ?? "");
  clientById(ctx.world, clientId);
  const pinnedAt = new Date().toISOString();
  pins.set(clientId, [{ id: a.id, question: a.question, answer: a.answer, citations: a.citations, pinnedByName: actorName(ctx), pinnedAt }, ...(pins.get(clientId) ?? [])]);
  return { answerId: a.id, clientId, pinnedAt };
});
on("GET", "/risk/disagreements", (ctx) => (need(ctx, "risk:read"), paged([], ctx.query)));
on("GET", "/cases", (ctx) => {
  need(ctx, "dashboard:read");
  return paged(ctx.world.cases.filter((c) => canSeeCase(ctx, c)).map((c) => caseView(ctx, c)), ctx.query);
});
const caseOr404 = (ctx: Ctx) => {
  const cs = ctx.world.cases.find((c) => c.id === ctx.params[0]);
  if (!cs || !canSeeCase(ctx, cs)) throw notFound();
  return cs;
};
on("GET", "/cases/:id", (ctx) => caseView(ctx, caseOr404(ctx)));
on("PATCH", "/cases/:id", (ctx) => {
  const cs = caseOr404(ctx);
  if (canSeeCase(ctx, cs) !== "full" || !ctx.perms.has("smr:write")) throw notFound();
  Object.assign(cs, ctx.body);
  return caseView(ctx, cs);
});
on("GET", "/cases/:id/smr", (ctx) => {
  const cs = caseOr404(ctx);
  const d = ctx.world.smr[cs.id];
  if (canSeeCase(ctx, cs) !== "full" && d) return { ...d, suspicionGrounds: null, narrative: null, transactions: [], redactedFields: ["suspicionGrounds", "narrative", "transactions"] };
  return d ?? { caseId: cs.id, version: 1, regime: "AUSTRAC_SMR", suspicionGrounds: cs.grounds ?? "", subjects: [], transactions: [], narrative: "", attachments: [], updatedBy: cs.openedBy, updatedAt: cs.openedAt };
});
on("PUT", "/cases/:id/smr", (ctx) => {
  const cs = caseOr404(ctx);
  if (canSeeCase(ctx, cs) !== "full" || !ctx.perms.has("smr:write")) throw notFound();
  const cur = ctx.world.smr[cs.id];
  const b = ctx.body as unknown as T.SmrDraft;
  if (cur && b.version !== cur.version) throw new Problem(409, "stale_version", "Changed elsewhere", "Someone else saved this draft. Reload to see their changes.");
  const next = { ...b, version: (cur?.version ?? 0) + 1, updatedBy: actorName(ctx), updatedAt: new Date().toISOString() };
  ctx.world.smr[cs.id] = next;
  audit(ctx.world, actorName(ctx), "case.updated", `Updated the draft report for ${cs.title.split(" · ")[0]}`, "case", cs.id, { restricted: true });
  return next;
});
on("POST", "/cases/:id/smr/submit", (ctx) => {
  const cs = caseOr404(ctx);
  if (!ctx.perms.has("smr:submit")) throw notFound();
  cs.smrStatus = "submitted";
  cs.status = "reported";
  const ref = `DEMO-SMR-${Math.floor(100000 + Math.random() * 899999)}`;
  audit(ctx.world, actorName(ctx), "case.reported", `Marked ${cs.title.split(" · ")[0]} as filed (${ref})`, "case", cs.id, { restricted: true });
  return { reference: ref, submittedAt: new Date().toISOString() };
});
on("GET", "/cases/:id/timeline", (ctx) => {
  const cs = caseOr404(ctx);
  return ctx.world.caseTimeline[cs.id] ?? [];
});

// ------------------------------------------------------------------ assistant
on("GET", "/assistant/suggestions", (ctx) => {
  need(ctx, "assistant:use");
  const c = ctx.query.get("clientId") ? clientById(ctx.world, ctx.query.get("clientId")!) : null;
  return c
    ? [`Who controls ${c.name}?`, `What changed for ${c.name} since onboarding?`]
    : ["Who controls Harbour Quay Developments Pty Ltd?", "How is Gregory Pell linked to our clients?", "What changed for Ironbark Ventures Pty Ltd since onboarding?", "How is Ben Okafor linked to Ava Calder?"];
});
const history: T.AssistantAnswer[] = [];
on("GET", "/assistant/history", (ctx) => (need(ctx, "assistant:use"), history.filter((h) => !ctx.query.get("clientId") || h.id.includes(ctx.query.get("clientId")!)).slice(-20).reverse()));
on("POST", "/assistant/ask", (ctx) => {
  need(ctx, "assistant:use");
  const q = String(ctx.body.question ?? "").trim();
  if (!q || q.length > 500) throw invalid("question", "Ask a question of up to 500 characters.");
  const ans = withGraph(ctx.world, answer(ctx.world, q, ctx.body.clientId ? String(ctx.body.clientId) : undefined));
  history.push(ans);
  return ans;
});

/** Like the API: the cited parties and links as one graphology payload. */
function withGraph(w: World, a: T.AssistantAnswer): T.AssistantAnswer {
  if (!a.highlight.nodeIds.length) return { ...a, graph: null };
  const nodes = new Map<string, T.GraphPayload["nodes"][number]>();
  const edges = new Map<string, T.GraphPayload["edges"][number]>();
  for (const id of a.highlight.nodeIds) {
    const p = partyGraph(w, id, today(), 1);
    p.nodes.forEach((n) => a.highlight.nodeIds.includes(n.key) && nodes.set(n.key, n));
    p.edges.forEach((e) => a.highlight.edgeIds.includes(e.key) && edges.set(e.key, e));
  }
  return { ...a, graph: { attributes: { focusId: null, asOf: today(), depth: 1, truncated: false, graphVersion: 0 }, nodes: [...nodes.values()], edges: [...edges.values()] } };
}

function findParty(w: World, name: string) {
  const n = name.toLowerCase().replace(/[?.]/g, "").trim();
  const ps = Object.values(w.parties).filter((p) => !p.mergedInto && p.kind !== "stack" && p.kind !== "address");
  return ps.find((p) => p.name.toLowerCase() === n) ?? ps.find((p) => p.name.toLowerCase().includes(n)) ?? ps.find((p) => n.includes(p.name.toLowerCase()));
}
function answer(w: World, question: string, clientId?: string): T.AssistantAnswer {
  const base = { id: `ask-${history.length + 1}${clientId ? "-" + clientId : ""}`, question, mode: "offline" as const, createdAt: new Date().toISOString(), graph: null };
  const cites: T.Citation[] = [];
  const cite = (edgeId: string) => {
    const r = w.rels.find((x) => x.id === edgeId)!;
    const label = `${w.parties[r.fromPartyId]!.name} → ${w.parties[r.toPartyId]!.name} · ${r.kind === "ownership" ? `${r.pct ?? "?"}%` : r.role}`;
    let i = cites.findIndex((c) => c.id === edgeId);
    if (i < 0) i = cites.push({ type: "edge", id: edgeId, label }) - 1;
    return `[${i + 1}]`;
  };
  const steps: T.AssistantStep[] = [];
  let m = question.match(/who (?:controls|owns|is behind) (.+?)\??$/i);
  if (m || (clientId && !/linked|connected|changed/i.test(question))) {
    const target = m ? findParty(w, m[1]!) : w.parties[w.clients.find((c) => c.id === clientId)!.partyId];
    const client = target && w.clients.find((c) => c.partyId === target.id);
    if (client) {
      const ubo = beneficialOwners(w, client, today(), w.settings.ubo.thresholdPct);
      steps.push({ tool: "who_controls", label: `Traced the owners of ${client.name}`, args: { clientId: client.id }, resultCount: ubo.owners.length });
      const owners = ubo.owners.filter((o) => o.isUbo);
      const nodeIds = new Set<string>([client.partyId]);
      const edgeIds = new Set<string>();
      const sentences = owners.map((o) => {
        const p = o.paths[0]!;
        p.nodeIds.forEach((x) => nodeIds.add(x));
        p.hops.forEach((h) => edgeIds.add(h.edgeId));
        const marks = p.hops.map((h) => cite(h.edgeId)).join("");
        return o.effectivePct != null && o.effectivePct >= ubo.thresholdPct
          ? `${o.name} owns ${o.effectivePct}% of ${client.name} through ${p.hops.length - 1 || "no"} intermediate ${p.hops.length - 1 === 1 ? "entity" : "entities"} ${marks}.`
          : `${o.name} controls it as ${o.controlRoles.join(" and ").toLowerCase()} ${marks}.`;
      });
      if (ubo.unexplainedPct > 0) sentences.push(`${ubo.unexplainedPct}% cannot be traced to a person yet.`);
      return { ...base, answer: owners.length ? `${owners.length === 1 ? "One person" : `${owners.length} people`} control ${client.name}. ${sentences.join(" ")}` : `No one reaches the 25% threshold for ${client.name}. ${sentences.join(" ")}`, citations: cites, steps, highlight: { nodeIds: [...nodeIds], edgeIds: [...edgeIds] }, grounded: true };
    }
  }
  m = question.match(/how is (.+?) (?:linked|connected) to (.+?)\??$/i);
  if (m) {
    const a = findParty(w, m[1]!);
    if (a && /our clients/i.test(m[2]!)) {
      const t = pullThread(w, a.id, today());
      steps.push({ tool: "find_party", label: `Found ${a.name}`, args: { q: m[1] }, resultCount: 1 }, { tool: "path_between", label: `Followed every link from ${a.name} to a client`, args: { partyId: a.id }, resultCount: t.entries.length });
      if (!t.entries.length) return { ...base, answer: `No connection found within 6 steps between ${a.name} and any client.`, citations: [], steps, highlight: { nodeIds: [a.id], edgeIds: [] }, grounded: true };
      const lines = t.entries.slice(0, 4).map((e) => {
        const p = e.paths[0]!;
        return `${e.clientName}: ${p.hops.map((h) => `${w.parties[h.fromId]!.name} ${h.kind === "ownership" ? `owns ${h.pct}% of` : `is ${(h.role ?? "").toLowerCase()} of`} ${w.parties[h.toId]!.name} ${cite(h.edgeId)}`).join(", ")}.`;
      });
      const nodeIds = new Set<string>([a.id]);
      const edgeIds = new Set<string>();
      t.entries.slice(0, 4).forEach((e) => e.paths[0]!.hops.forEach((h) => (edgeIds.add(h.edgeId), nodeIds.add(h.fromId), nodeIds.add(h.toId))));
      return { ...base, answer: `${a.name} reaches ${t.entries.length} client${t.entries.length > 1 ? "s" : ""}. ${lines.join(" ")}`, citations: cites, steps, highlight: { nodeIds: [...nodeIds], edgeIds: [...edgeIds] }, grounded: true };
    }
    const b = findParty(w, m[2]!);
    if (a && b) {
      const conn = connection(w, a.id, b.id, today());
      steps.push({ tool: "path_between", label: `Looked for links between ${a.name} and ${b.name}`, args: { from: a.id, to: b.id }, resultCount: conn.paths.length });
      if (!conn.found) return { ...base, answer: `No connection found within 6 steps between ${a.name} and ${b.name}.`, citations: [], steps, highlight: { nodeIds: [a.id, b.id], edgeIds: [] }, grounded: true };
      const p = conn.paths[0]!;
      const text = p.hops.map((h) => `${w.parties[h.fromId]!.name} ${h.kind === "ownership" ? `owns ${h.pct ?? "an unknown share"}% of` : `is ${(h.role ?? "").toLowerCase()} of`} ${w.parties[h.toId]!.name} ${cite(h.edgeId)}`).join("; ");
      return { ...base, answer: `${a.name} and ${b.name} are ${p.hops.length} step${p.hops.length > 1 ? "s" : ""} apart. ${text}.`, citations: cites, steps, highlight: { nodeIds: p.nodeIds, edgeIds: p.hops.map((h) => h.edgeId) }, grounded: true };
    }
  }
  m = question.match(/what changed for (.+?) since/i);
  if (m) {
    const target = findParty(w, m[1]!);
    const client = target && w.clients.find((c) => c.partyId === target.id);
    if (client) {
      const from = client.onboardedOn ?? daysFromToday(-365);
      const d = graphDiff(w, client, from, today());
      steps.push({ tool: "changes_since", label: `Compared ${client.name} today with onboarding`, args: { from }, resultCount: d.summary.length });
      const marks = [...d.added, ...d.removed].map((e) => cite(e.id));
      const text = d.summary.length ? d.summary.map((s, i) => `${s.replace(/\.$/, "")} ${marks[i] ?? ""}.`).join(" ") : "Nothing in the structure has changed since onboarding.";
      return { ...base, answer: text, citations: cites, steps, highlight: { nodeIds: [client.partyId, ...d.added.flatMap((e) => [e.source, e.target])], edgeIds: d.added.map((e) => e.id) }, grounded: true };
    }
  }
  return { ...base, answer: "I couldn't confirm that from the ownership records. Ask who controls a client, how a person is linked to your clients, or what changed for a client since onboarding.", citations: [], steps, highlight: { nodeIds: [], edgeIds: [] }, grounded: false };
}

// ------------------------------------------------------------------ audit, jobs
on("GET", "/audit", (ctx) => {
  need(ctx, "audit:read");
  const q = ctx.query;
  let rows = ctx.world.audit.filter((a) => !a.metadata.restricted || ctx.perms.has("smr:read"));
  if (q.get("action")) rows = rows.filter((a) => a.action.startsWith(q.get("action")!));
  if (q.get("resourceId")) rows = rows.filter((a) => a.resourceId === q.get("resourceId"));
  if (q.get("actorId")) rows = rows.filter((a) => a.actorName === userById(q.get("actorId")!)?.fullName);
  if (q.get("from")) rows = rows.filter((a) => a.createdAt.slice(0, 10) >= q.get("from")!);
  if (q.get("to")) rows = rows.filter((a) => a.createdAt.slice(0, 10) <= q.get("to")!);
  return paged([...rows].reverse(), q);
});
on("GET", "/audit/verify", (ctx) => {
  need(ctx, "audit:read");
  let prev = "0".repeat(64);
  for (const a of ctx.world.audit) {
    if (a.prevHash !== prev || a.hash !== seal(prev, `${a.action}|${a.label}|${a.createdAt}`)) return { valid: false, checked: a.id, brokenAt: a.id };
    prev = a.hash;
  }
  return { valid: true, checked: ctx.world.audit.length, brokenAt: null } satisfies T.AuditVerify;
});
on("GET", "/jobs/:id", (ctx) => ({ id: ctx.params[0], kind: "job", status: "succeeded", progress: 100, createdAt: new Date().toISOString() }));

// ------------------------------------------------------------------ transport
const json = (status: number, data: unknown, headers: Record<string, string> = {}) =>
  new Response(data === undefined ? null : JSON.stringify(data), { status: data === undefined && status < 300 ? 204 : status, headers: { "Content-Type": status >= 400 ? "application/problem+json" : "application/json", "X-Request-ID": `mock-${Date.now().toString(36)}`, ...headers } });

const LATENCY = import.meta.env?.MODE === "test" ? 0 : 90;

export async function mockFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const url = new URL(input, "http://kinroot.local");
  const method = (init.method ?? "GET").toUpperCase();
  const path = url.pathname.replace(/^\/api\/v1/, "");
  let body: Record<string, unknown> = {};
  if (init.body instanceof FormData) body = Object.fromEntries(init.body.entries());
  else if (typeof init.body === "string") body = JSON.parse(init.body) as Record<string, unknown>;
  if (LATENCY) await new Promise((r) => setTimeout(r, LATENCY + Math.random() * 90));
  if (method !== "GET" && !(init.headers as Record<string, string> | undefined)?.["X-CSRFToken"]) {
    return json(403, { type: "https://kinroot.dev/problems/csrf_failed", title: "CSRF check failed", status: 403, code: "csrf_failed", detail: "Refresh the page and try again." });
  }
  const s = loadSession();
  const w = world(s?.orgId ?? "org-harbourline");
  const role = s ? roleIn(w, s.userId) : null;
  const ctx: Omit<Ctx, "params"> = { session: s, world: w, role, perms: new Set(role ? permissionsFor(role) : []), query: url.searchParams, body };
  for (const [m, re, h] of routes) {
    if (m !== method) continue;
    const match = path.match(re);
    if (!match) continue;
    try {
      const data = h({ ...ctx, params: match.slice(1).map(decodeURIComponent) });
      return json(200, data);
    } catch (err) {
      if (err instanceof Problem) {
        return json(err.status, { type: `https://kinroot.dev/problems/${err.code}`, title: err.title, status: err.status, detail: err.detail, code: err.code, errors: err.errors, requestId: "mock" }, err.status === 429 ? { "Retry-After": "900" } : {});
      }
      console.error(err);
      return json(500, { type: "https://kinroot.dev/problems/internal_error", title: "Something went wrong", status: 500, code: "internal_error" });
    }
  }
  return json(404, { type: "https://kinroot.dev/problems/not_found", title: "Not found", status: 404, code: "not_found", detail: "This page isn't available to you." });
}
