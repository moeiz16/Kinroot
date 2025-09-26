import { describe, expect, it } from "vitest";
import { beneficialOwners, clientGraph, graphDiff } from "../api/mock/graphcalc";
import { buildWorld } from "../api/mock/world";
import type { GraphPath, GraphPayload } from "../api/types";
import { today } from "../lib/dates";
import { applyDiff, citationIds, compound, fromPayload, initials, ledgerTwin, pct, primaryOwner, stringsForOwner } from "./transforms";

const w = buildWorld();
const hq = w.clients.find((c) => c.id === "c-harbour-quay")!;
const payload = clientGraph(w, hq, today());
const ubo = beneficialOwners(w, hq, today());

describe("transforms", () => {
  it("makes initials without honorifics", () => {
    expect(initials("Hon. Julian Whitfield")).toBe("JW");
    expect(initials("Dr Amelia Ross")).toBe("AR");
    expect(initials("Ava Calder")).toBe("AC");
  });
  it("formats percentages", () => {
    expect(pct(49.6)).toBe("49.6%");
    expect(pct(62)).toBe("62%");
    expect(pct(null)).toBe("?%");
  });
  it("numbers links E-01, E-02 … in payload order", () => {
    const ids = citationIds(payload);
    expect(ids.get(payload.edges[0]!.key)).toBe("E-01");
    expect(ids.get(payload.edges[9]!.key)).toBe("E-10");
  });
  it("maps parties to board shapes with glyphs and labels", () => {
    const { nodes } = fromPayload(payload, { ubo });
    const client = nodes.find((n) => n.client)!;
    expect(client.label).toBe("Harbour Quay Developments Pty Ltd");
    const kestrel = nodes.find((n) => n.id === "p-kestrel-ventures")!;
    expect(kestrel.glyph).toBe("VG");
    expect(kestrel.flags.map((f) => f.text)).toContain("◆ Owners not disclosed");
    expect(nodes.find((n) => n.id === "p-calder-trust")!.kind).toBe("trust");
  });
  it("labels the beneficial owner and writes an aria label naming the path", () => {
    const { nodes } = fromPayload(payload, { ubo });
    const ava = nodes.find((n) => n.id === "p-ava-calder")!;
    expect(ava.sub).toBe("Beneficial owner · 49.6%");
    expect(ava.aria).toMatch(/Ava Calder, person, beneficial owner, 49.6 percent through Calder Family Trust and Bellmere Holdings Pty Ltd and Kestrel Ventures Ltd/);
  });
  it("adds an unknown party for the share nobody has declared", () => {
    const { nodes, edges } = fromPayload(payload, { ubo });
    const unk = nodes.find((n) => n.kind === "unknown")!;
    expect(unk.label).toBe("Unknown shareholders");
    expect(edges.find((e) => e.s === unk.id)!.label).toBe("20%");
  });
  it("draws a circular holding as a loop only where ownership really cycles", () => {
    const tr = w.clients.find((c) => c.id === "c-tasman-ridge")!;
    const { edges } = fromPayload(clientGraph(w, tr, today()));
    const loops = edges.filter((e) => e.curve);
    expect(loops).toHaveLength(1);
    expect(loops[0]!.label).toMatch(/Circular · 60% ↺/);
    expect(fromPayload(payload).edges.some((e) => e.curve)).toBe(false);
  });
  it("gives every node a parent to unfold from", () => {
    const { nodes } = fromPayload(payload, { ubo });
    expect(nodes.filter((n) => !n.client).every((n) => !!n.from)).toBe(true);
  });
  it("tags additions and brings back removals for the before/after overlay", () => {
    const d = graphDiff(w, hq, hq.onboardedOn!, today());
    const out = applyDiff(fromPayload(payload, { ubo }), d, "4 Mar");
    expect(out.edges.find((e) => e.id === "r-kestrel-duarte")!.added).toBe("+ New since 4 Mar");
    const gone = out.edges.find((e) => e.id === "r-kestrel-ruiz")!;
    expect(gone.removed).toMatch(/^– Removed/);
    expect(out.nodes.find((n) => n.id === "p-ana-ruiz")!.removed).toBeTruthy();
  });
  it("compounds the % hop by hop for the string's tag", () => {
    const path: GraphPath = {
      nodeIds: ["mc", "ci", "cn", "c"],
      hops: [
        { edgeId: "a", fromId: "mc", toId: "ci", kind: "ownership", pct: 100 },
        { edgeId: "b", fromId: "ci", toId: "cn", kind: "ownership", pct: 80 },
        { edgeId: "c", fromId: "cn", toId: "c", kind: "ownership", pct: 62 },
      ],
      effectivePct: 49.6,
      sentence: "",
    };
    const c = compound(path, () => "Margaret Calder");
    expect(c.equation).toBe("100% × 80% × 62% = 49.6%");
    expect(c.value).toBe(49.6);
    expect(c.steps!.map((s) => s.value)).toEqual(["100%", "80%", "49.6%"]);
  });
  it("pulls the strongest path at full weight and the rest faint", () => {
    const ava = ubo.owners.find((o) => o.name === "Ava Calder")!;
    const specs = stringsForOwner(ava, (id) => id);
    expect(specs[0]!.weight).toBe("full");
    expect(specs[0]!.ids[0]).toBe("p-ava-calder");
    expect(specs.slice(1).every((s) => s.weight === "faint")).toBe(true);
    expect(primaryOwner(ubo)!.name).toBe("Ava Calder");
  });
  it("writes a text twin of the board", () => {
    const { nodes, edges } = fromPayload(payload, { ubo });
    const twin = ledgerTwin(nodes, edges);
    expect(twin.find((t) => t.id === "p-bellmere")!.links).toContain("owns 80% of Kestrel Ventures Ltd");
  });
  it("copes with an empty payload", () => {
    const empty: GraphPayload = { attributes: { focusId: null, asOf: "", depth: 1, truncated: false, graphVersion: 0 }, nodes: [], edges: [] };
    expect(fromPayload(empty)).toEqual({ nodes: [], edges: [] });
  });
});
