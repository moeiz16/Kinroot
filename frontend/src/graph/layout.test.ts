import { describe, expect, it } from "vitest";
import { constellationLayout, labelRoom, layered, seeded } from "./layout";
import type { BEdge, BNode } from "./model";

const node = (id: string, level: number): BNode => ({ id, kind: "company", label: id, glyph: "", level, flags: [], aria: id, x: 0, y: 0 });

describe("layered layout", () => {
  it("puts the client on top and owners in rows beneath", () => {
    const nodes = [node("c", 0), node("a", 1), node("b", 1), node("p", 2)];
    const edges: BEdge[] = [
      { id: "1", s: "a", t: "c", kind: "own" },
      { id: "2", s: "b", t: "c", kind: "own" },
      { id: "3", s: "p", t: "a", kind: "own" },
    ];
    const pos = layered(nodes, edges, { rankSep: 160, nodeSep: 205 });
    expect(pos.get("c")!.y).toBe(0);
    expect(pos.get("a")!.y).toBe(160);
    expect(pos.get("p")!.y).toBe(320);
    expect(Math.abs(pos.get("a")!.x - pos.get("b")!.x)).toBeGreaterThanOrEqual(205);
  });
  it("moves a party linked to a neighbour on the same row down a row", () => {
    const nodes = [node("c", 0), node("t", 1), node("x", 1)];
    const edges: BEdge[] = [
      { id: "1", s: "t", t: "c", kind: "ctrl" },
      { id: "2", s: "x", t: "t", kind: "ctrl" },
    ];
    const pos = layered(nodes, edges);
    expect(pos.get("x")!.y).toBeGreaterThan(pos.get("t")!.y);
  });
  it("keeps parties near the one they own (barycentre)", () => {
    const nodes = [node("c", 0), node("l", 1), node("r", 1), node("pl", 2), node("pr", 2)];
    const edges: BEdge[] = [
      { id: "1", s: "l", t: "c", kind: "own" },
      { id: "2", s: "r", t: "c", kind: "own" },
      { id: "3", s: "pr", t: "r", kind: "own" },
      { id: "4", s: "pl", t: "l", kind: "own" },
    ];
    const pos = layered(nodes, edges);
    expect(pos.get("pl")!.x < pos.get("pr")!.x).toBe(pos.get("l")!.x < pos.get("r")!.x);
  });
});

describe("constellation layout", () => {
  const nodes = Array.from({ length: 12 }, (_, i) => ({ ...node(`n${i}`, 0), pin: true }));
  const edges: BEdge[] = [
    { id: "a", s: "n0", t: "n1", kind: "faint" },
    { id: "b", s: "n0", t: "n2", kind: "faint" },
  ];
  it("is stable for the same client book", () => {
    const a = constellationLayout(nodes, edges);
    const b = constellationLayout(nodes, edges);
    expect([...a.entries()]).toEqual([...b.entries()]);
  });
  it("keeps pins far enough apart for their labels", () => {
    const placed = constellationLayout(nodes, edges);
    const ids = [...placed.keys()];
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) {
        const a = placed.get(ids[i]!)!;
        const b = placed.get(ids[j]!)!;
        const left = a.x <= b.x ? ids[i]! : ids[j]!;
        const room = labelRoom(nodes.find((n) => n.id === left)!);
        const close = Math.abs(a.x - b.x) < room - 1 && Math.abs(a.y - b.y) < 40;
        expect(close).toBe(false);
      }
  });
  it("uses a seeded random so pictures repeat", () => {
    const r1 = seeded(7);
    const r2 = seeded(7);
    expect([r1(), r1(), r1()]).toEqual([r2(), r2(), r2()]);
  });
});
