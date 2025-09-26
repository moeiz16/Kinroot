import { describe, expect, it } from "vitest";
import { daysFromToday, today } from "../../lib/dates";
import { beneficialOwners, clientGraph, connection, constellation, graphDiff, pullThread, search } from "./graphcalc";
import { buildWorld } from "./world";

const w = buildWorld();
const client = (key: string) => w.clients.find((c) => c.id === `c-${key}`)!;

describe("beneficial owners", () => {
  it("compounds ownership through every layer (trust over company over offshore holding)", () => {
    const u = beneficialOwners(w, client("harbour-quay"), today());
    const ava = u.owners.find((o) => o.name === "Ava Calder")!;
    const ben = u.owners.find((o) => o.name === "Ben Okafor")!;
    expect(ava.effectivePct).toBe(49.6);
    expect(ava.isUbo).toBe(true);
    expect(ava.via).toBe("both");
    expect(ben.effectivePct).toBe(30.4);
    expect(u.unexplainedPct).toBe(20);
    expect(u.warnings).toEqual(expect.arrayContaining(["unknown_owner", "nominee_in_chain"]));
  });
  it("reports circular holdings without looping", () => {
    const u = beneficialOwners(w, client("tasman-ridge"), today());
    expect(u.cycles.length).toBeGreaterThan(0);
    expect(u.warnings).toContain("circular_ownership");
    expect(u.owners.find((o) => o.name === "Marcus Hale")!.effectivePct).toBe(50);
    expect(u.owners.find((o) => o.name === "Hemi Walker")!.effectivePct).toBe(15);
  });
  it("treats each partner over the threshold as a beneficial owner", () => {
    const u = beneficialOwners(w, client("ferris-wu"), today());
    expect(u.owners.filter((o) => o.isUbo)).toHaveLength(3);
  });
  it("finds no owner for a company limited by guarantee, only controllers", () => {
    const u = beneficialOwners(w, client("blue-gum"), today());
    expect(u.owners.every((o) => o.via === "control")).toBe(true);
  });
});

describe("graph views", () => {
  it("flags the UBO in the client graph", () => {
    const g = clientGraph(w, client("harbour-quay"), today());
    expect(g.nodes.find((n) => n.key === "p-ava-calder")!.attributes.flags).toContain("ubo");
  });
  it("diffs the structure against onboarding", () => {
    const c = client("harbour-quay");
    const d = graphDiff(w, c, c.onboardedOn!, today());
    expect(d.added.map((e) => e.id)).toContain("r-kestrel-duarte");
    expect(d.removed.map((e) => e.id)).toContain("r-kestrel-ruiz");
    expect(d.summary.join(" ")).toMatch(/Marisol Duarte became director of Kestrel Ventures Ltd/);
  });
  it("records a changed holding as a change, not an add", () => {
    const d = graphDiff(w, client("ironbark-ventures"), daysFromToday(-60), today());
    expect(d.changed[0]!.before.pct).toBe(100);
    expect(d.changed[0]!.after.pct).toBe(60);
  });
  it("pulls the thread from a nominee director to every client", () => {
    const t = pullThread(w, "p-gregory-pell", today());
    expect(t.entries.map((e) => e.clientName).sort()).toEqual(["Coralline Logistics Pty Ltd", "Lumen Trade Pty Ltd", "Silverbirch Imports Pty Ltd"]);
  });
  it("finds the shortest connection between two people", () => {
    const c = connection(w, "p-ben-okafor", "p-ava-calder", today());
    expect(c.found).toBe(true);
    expect(c.paths[0]!.hops.length).toBeLessThanOrEqual(3);
  });
  it("builds the constellation without duplicate parties", () => {
    const g = constellation(w, today());
    const keys = g.nodes.map((n) => n.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(g.edges.every((e) => keys.includes(e.source) && keys.includes(e.target))).toBe(true);
  });
  it("searches clients first", () => {
    expect(search(w, "calder")[0]!.flags).toContain("client");
  });
});
