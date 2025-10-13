// Pieces added when the web app first ran against the live API.
import { describe, expect, it } from "vitest";
import type { AssistantAnswer, MatchReason, TrayItem } from "../api/types";
import { listSourceLabel } from "../lib/format";
import { answerScene } from "../routes/Ask";
import { trayHref } from "../routes/BoardHome";
import { effectOf, heldBack } from "../routes/Fuse";

const reason = (contribution: number, label = "Same date of birth", direction: "for" | "against" = "for"): MatchReason => ({ feature: "dob_exact", label, direction, contribution, value: 1 });

describe("file tray", () => {
  const slip: TrayItem = { kind: "merge_review", id: "m1", clientId: "c1", title: "Possible duplicate", subtitle: "87 in 100 likely the same", dueOn: null, href: "/fuse/m1" };
  it("follows the API's href when it is an app route", () => {
    expect(trayHref({ ...slip, href: "/clients/c1/risk", kind: "signoff" })).toBe("/clients/c1/risk");
  });
  it("falls back to the kind when the href is missing", () => {
    expect(trayHref({ ...slip, href: "" })).toBe("/fuse/m1");
  });
});

describe("match file effects", () => {
  it("draws bars relative to the strongest reason", () => {
    expect(effectOf(reason(2), 2).up).toBe(50);
    expect(effectOf(reason(0.5), 2).up).toBeLessThan(20);
  });
  it("shows a partial date match as similar, and missing evidence as can't compare", () => {
    expect(effectOf(reason(1, "Same month and year of birth"), 1).glyph).toBe("≈");
    expect(effectOf(reason(0.3, "No shared identifier to compare"), 1)).toMatchObject({ glyph: "—", up: 0, down: 0 });
  });
  it("explains why a likely pair still waits for a person", () => {
    expect(heldBack({ dob_exact: 0, dob_transposed: 0 })).toBe("the birth dates differ");
    expect(heldBack({ dob_exact: 1, id_agree: 0 })).toBe("the registration numbers differ");
    expect(heldBack({ dob_exact: 1, id_agree: 1 })).toBeNull();
  });
});

describe("screening sources", () => {
  it("never shows a raw list version string", () => {
    expect(listSourceLabel("bundled-sample")).toBe("Sample list · fictional entries");
    expect(listSourceLabel("opensanctions")).toBe("OpenSanctions");
  });
});

describe("ask the board", () => {
  const base: AssistantAnswer = { id: "a1", question: "Who controls X?", answer: "Pat owns 100% of X [1].", citations: [{ type: "edge", id: "e1", label: "Pat → X" }], steps: [], highlight: { nodeIds: ["p", "x"], edgeIds: ["e1"] }, mode: "offline", createdAt: "2025-10-01T09:00:00+10:00", grounded: true, graph: null };
  it("draws the path from the answer's own graph, numbering cited links", () => {
    const graph = {
      attributes: { focusId: null, asOf: "2025-10-01", depth: 1, truncated: false, graphVersion: 1 },
      nodes: [
        { key: "p", attributes: { label: "Pat Lee", kind: "person", jurisdiction: "AU", identifiers: {}, flags: [], clientId: null, riskRating: null, level: null, effectivePct: null, mergedCount: 0 } },
        { key: "x", attributes: { label: "X Pty Ltd", kind: "company", jurisdiction: "AU", identifiers: {}, flags: ["client"], clientId: "c1", riskRating: "low", level: null, effectivePct: null, mergedCount: 0 } },
      ],
      edges: [{ key: "e1", source: "p", target: "x", attributes: { kind: "ownership", label: "100%", pct: 100, interest: "shares", role: null, nominee: false, validFrom: null, validTo: null, sourceRef: "manual" } }],
    } as unknown as AssistantAnswer["graph"];
    const built = answerScene({ ...base, graph })!;
    expect(built.scene.nodes.map((n) => n.id).sort()).toEqual(["p", "x"]);
    expect(built.scene.edges[0]!.cite).toBe(1);
    expect(built.strings).toHaveLength(1);
  });
  it("draws nothing when the answer traced no path", () => {
    expect(answerScene(base)).toBeNull();
  });
});
