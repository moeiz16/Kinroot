// The fixture adapter follows the contract (status codes, permissions, tipping-off), so the app is exercised
// against the same behaviour it will meet from the API.
import { describe, expect, it } from "vitest";
import { ApiError } from "../client";
import { api } from "../endpoints";

async function as(email: string) {
  return api.auth.login(email, "Kinroot-demo-2025!");
}
const code = (p: Promise<unknown>) => p.then(() => "ok").catch((e: ApiError) => e.code);

describe("fixture adapter: auth", () => {
  it("rejects a wrong password generically and counts the tries", async () => {
    const err = (await api.auth.login("daniel@harbourline.example", "nope").catch((e) => e)) as ApiError;
    expect(err.status).toBe(401);
    expect(err.code).toBe("invalid_credentials");
    expect(err.message).toMatch(/4 tries left/);
  });
  it("locks an email after five failures", async () => {
    for (let i = 0; i < 5; i++) await api.auth.login("tom@harbourline.example", "x").catch(() => undefined);
    expect(await code(as("tom@harbourline.example"))).toBe("rate_limited");
  });
  it("returns the member's permissions on sign-in", async () => {
    const me = await as("daniel@harbourline.example");
    expect(me.membership?.role).toBe("compliance_officer");
    expect(me.membership?.permissions).toContain("smr:read");
    expect(me.activeOrg?.name).toBe("Harbourline Legal (Sydney)");
  });
  it("requires sign-in for app data", async () => {
    expect(await code(api.clients.list())).toBe("not_authenticated");
  });
});

describe("fixture adapter: clients and graph", () => {
  it("pages and filters the client book", async () => {
    await as("daniel@harbourline.example");
    const page = await api.clients.list({ pageSize: 10 });
    expect(page.total).toBe(30);
    expect(page.totalPages).toBe(3);
    const high = await api.clients.list({ rating: "high", pageSize: 100 });
    expect(high.items.every((c) => c.rating === "high")).toBe(true);
  });
  it("returns a graphology payload with the client at level 0", async () => {
    await as("daniel@harbourline.example");
    const g = await api.clients.graph("c-harbour-quay");
    const root = g.nodes.find((n) => n.key === g.attributes.focusId)!;
    expect(root.attributes.level).toBe(0);
    expect(root.attributes.flags).toContain("client");
    expect(g.edges.some((e) => e.attributes.kind === "ownership" && e.attributes.pct === 62)).toBe(true);
  });
  it("rejects shareholdings over 100%", async () => {
    await as("tom@harbourline.example");
    const c = await api.clients.get("c-brightwater-re");
    const p = await api.clients.addParty(c.id, { kind: "person", name: "New Holder" });
    const err = (await api.relationships.create({ fromPartyId: p.id, toPartyId: c.partyId, kind: "ownership", pct: 10, validFrom: "2025-01-01" }).catch((e) => e)) as ApiError;
    expect(err.code).toBe("over_allocated");
  });
  it("holds client contact while a restricted case is open, with neutral wording", async () => {
    await as("tom@harbourline.example");
    const err = (await api.clients.communicate("c-aurelian-shipping", "information_request", "hi").catch((e) => e)) as ApiError;
    expect(err.status).toBe(409);
    expect(err.code).toBe("action_held");
    expect(err.message).not.toMatch(/case|report|suspic/i);
  });
});

describe("fixture adapter: tipping-off", () => {
  it("gives fee earners an empty register and a 404 for a case id", async () => {
    await as("tom@harbourline.example");
    expect((await api.cases.list()).total).toBe(0);
    expect(await code(api.cases.get("case-aurelian"))).toBe("not_found");
    expect(await code(api.cases.get("case-that-does-not-exist"))).toBe("not_found");
  });
  it("redacts grounds for summary access", async () => {
    await as("margaret@harbourline.example");
    const c = await api.cases.get("case-aurelian");
    expect(c.accessLevel).toBe("summary");
    expect(c.grounds).toBeNull();
    expect(c.redactedFields).toContain("grounds");
    const d = await api.cases.smr("case-aurelian");
    expect(d.narrative).toBeNull();
    expect(d.redactedFields).toContain("narrative");
  });
  it("shows the full case to the compliance officer", async () => {
    await as("daniel@harbourline.example");
    const c = await api.cases.get("case-aurelian");
    expect(c.grounds).toMatch(/Aurelian Maritime FZE/);
    expect((await api.cases.smr("case-aurelian")).version).toBe(3);
  });
  it("hides restricted audit rows from people who cannot see cases", async () => {
    await as("ruth@harbourline.example");
    const rows = await api.audit.list({ pageSize: 200 });
    expect(rows.items.some((r) => r.metadata.restricted)).toBe(false);
    await as("daniel@harbourline.example");
    const all = await api.audit.list({ pageSize: 200 });
    expect(all.items.some((r) => r.metadata.restricted)).toBe(true);
  });
  it("omits the restricted count from the dashboard for others", async () => {
    await as("tom@harbourline.example");
    expect((await api.dashboard()).counts.smrDrafts).toBeUndefined();
  });
});

describe("fixture adapter: decisions", () => {
  it("verifies the seal chain", async () => {
    await as("ruth@harbourline.example");
    const v = await api.audit.verify();
    expect(v.valid).toBe(true);
    expect(v.checked).toBeGreaterThan(150);
  });
  it("refuses to decide a pair twice", async () => {
    await as("daniel@harbourline.example");
    await api.resolution.decide("m-reyes", "merge", "");
    expect(await code(api.resolution.decide("m-reyes", "merge", ""))).toBe("already_decided");
  });
  it("needs a reason to keep records apart", async () => {
    await as("daniel@harbourline.example");
    expect(await code(api.resolution.decide("m-okafor", "not_match", ""))).toBe("validation_error");
  });
  it("needs a 10-character reason for a screening decision", async () => {
    await as("daniel@harbourline.example");
    expect(await code(api.screening.review("h-petrov", "false_positive", "short"))).toBe("validation_error");
    const h = await api.screening.review("h-petrov", "false_positive", "Different birth year and nationality.");
    expect(h.status).toBe("false_positive");
  });
  it("blocks the client on a true sanctions match", async () => {
    await as("daniel@harbourline.example");
    await api.screening.review("h-aurelian", "true_match", "Same entity on the consolidated list.");
    expect((await api.clients.get("c-aurelian-shipping")).status).toBe("blocked");
  });
  it("keeps retention at the statutory minimum", async () => {
    await as("tom@harbourline.example");
    expect(await code(api.settings.patch({ retention: { years: 8, trigger: "relationship_end", legalHoldClientIds: [] } }))).toBe("forbidden");
    await as("daniel@harbourline.example");
    expect(await code(api.settings.patch({ retention: { years: 5, trigger: "relationship_end", legalHoldClientIds: [] } }))).toBe("validation_error");
  });
  it("answers a who-controls question with cited links", async () => {
    await as("daniel@harbourline.example");
    const a = await api.assistant.ask("Who controls Harbour Quay Developments Pty Ltd?");
    expect(a.grounded).toBe(true);
    expect(a.answer).toMatch(/Ava Calder owns 49\.6%/);
    expect(a.answer).toMatch(/\[1\]/);
    expect(a.citations.length).toBeGreaterThan(2);
  });
  it("declines questions it cannot ground", async () => {
    await as("daniel@harbourline.example");
    const a = await api.assistant.ask("What is the weather?");
    expect(a.grounded).toBe(false);
    expect(a.citations).toHaveLength(0);
  });
});
