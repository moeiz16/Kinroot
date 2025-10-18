import { describe, expect, it } from "vitest";
import { addBusinessDays, businessDaysUntil, daysBetween, dueIn, fmtDate, tranche2Line } from "./dates";
import { likelihood, ratingLook } from "./format";
import { permissionsFor } from "./permissions";

describe("dates", () => {
  it("words Tranche 2 timing from today, never as a fixed past event", () => {
    expect(tranche2Line(new Date(2025, 9, 15))).toBe("Tranche 2 obligations start in 259 days.");
    expect(tranche2Line(new Date(2026, 5, 30))).toBe("Tranche 2 obligations start tomorrow.");
    expect(tranche2Line(new Date(2026, 6, 1))).toBe("Tranche 2 obligations in force since 1 July 2026.");
  });
  it("counts SMR deadlines in business days", () => {
    expect(addBusinessDays("2025-10-10", 3)).toBe("2025-10-15"); // Friday → Wednesday
    expect(businessDaysUntil("2025-10-15", new Date(2025, 9, 10))).toBe(3);
  });
  it("formats dates the Kinroot way", () => {
    expect(fmtDate("2025-03-04")).toBe("4 Mar 2025");
    expect(fmtDate("2025-03-04", { year: false })).toBe("4 Mar");
    expect(fmtDate(null)).toBe("—");
    expect(daysBetween("2025-01-01", "2025-01-31")).toBe(30);
  });
});

describe("status language", () => {
  it("pairs every rating with a glyph and a word", () => {
    expect(ratingLook("high")).toEqual({ cls: "high", glyph: "▲", word: "High" });
    expect(ratingLook("medium").word).toBe("Review");
    expect(ratingLook("low").glyph).toBe("●");
    expect(ratingLook(null).word).toBe("Not rated");
  });
  it("states match likelihood as N in 100", () => {
    expect(likelihood(0.873)).toBe("87 in 100");
  });
});

describe("permissions", () => {
  it("gives restricted reports to the compliance officer only", () => {
    expect(permissionsFor("compliance_officer")).toContain("smr:read");
    for (const r of ["owner", "partner", "fee_earner", "auditor"] as const) expect(permissionsFor(r)).not.toContain("smr:read");
  });
  it("keeps the independent reviewer read-only", () => {
    const p = permissionsFor("auditor");
    expect(p).toContain("audit:read");
    expect(p.some((x) => x.endsWith(":write") || x.endsWith(":decide"))).toBe(false);
  });
});

describe("due in words", () => {
  const now = new Date(2024, 9, 10);
  it("counts days, then weeks, then months from today", () => {
    expect(dueIn("2024-10-09", now)).toBe("overdue");
    expect(dueIn("2024-10-10", now)).toBe("today");
    expect(dueIn("2024-10-11", now)).toBe("tomorrow");
    expect(dueIn("2024-11-04", now)).toBe("in 25 days");
    expect(dueIn("2024-12-14", now)).toBe("in 9 weeks");
    expect(dueIn("2025-08-06", now)).toBe("in 10 months");
    expect(dueIn(null, now)).toBe("—");
  });
});
