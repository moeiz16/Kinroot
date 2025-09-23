// Seeded sample structures for the landing trace. Fictional companies and people; offline, no API.
import type { BEdge, BNode, StringSpec } from "../../graph/model";

export interface Scenario {
  id: string;
  name: string;
  meta: string;
  chip?: string;
  nodes: BNode[];
  edges: BEdge[];
  string: StringSpec;
  ownerSub?: { id: string; text: string };
  slip: { look: "review" | "high"; lead: string; title: string; reasons: { n: number; node: string; text: string }[]; next: string };
}

type N = Omit<BNode, "flags" | "aria" | "glyph"> & { glyph?: string; flags?: BNode["flags"] };
const node = (n: N): BNode => ({ flags: [], aria: `${n.label}${n.sub ? ", " + n.sub : ""}`, glyph: n.glyph ?? "", ...n });

export const SCENARIOS: Scenario[] = [
  {
    id: "bellmere",
    name: "Bellmere Holdings Pty Ltd",
    meta: "ACN 614 203 778 · NSW",
    nodes: [
      node({ id: "c", kind: "company", client: true, label: "", sub: "ACN 614 203 778 · NSW", glyph: "AU", x: 820, y: 250, level: 0 }),
      node({ id: "do", kind: "person", label: "Daniel Okoro", sub: "Director", glyph: "DO", x: 560, y: 410, level: 1, from: "c" }),
      node({ id: "cn", kind: "company", label: "Calder Nominees Pty Ltd", sub: "ACN 602 118 405", glyph: "AU", x: 820, y: 410, level: 1, from: "c" }),
      node({ id: "hc", kind: "company", label: "Halyard Capital Ltd", sub: "BVI 1874402", glyph: "VG", flags: [{ text: "◆ Owners not disclosed", level: "review" }], x: 1050, y: 410, level: 1, from: "c", badge: 2 }),
      node({ id: "ci", kind: "company", label: "Calder Investments Pty Ltd", sub: "ACN 151 377 920", glyph: "AU", x: 560, y: 570, level: 2, from: "cn" }),
      node({ id: "wt", kind: "trust", label: "Wattle Street Family Trust", sub: "ABN 33 604 512 118", glyph: "T", x: 810, y: 570, level: 2, from: "cn" }),
      node({ id: "uk", kind: "unknown", label: "Unknown shareholders", sub: "1 or more", glyph: "?", x: 1050, y: 570, level: 2, from: "hc" }),
      node({ id: "pv", kind: "person", label: "Peter Voss", sub: "Director", glyph: "PV", flags: [{ text: "▲ 41 dormant companies", level: "high" }], x: 1250, y: 570, level: 2, from: "hc", badge: 3 }),
      node({ id: "mc", kind: "person", label: "Margaret Calder", sub: "Shareholder", glyph: "MC", x: 560, y: 730, level: 3, from: "ci", badge: 1 }),
      node({ id: "tc", kind: "person", label: "Tom Calder", sub: "Appointor", glyph: "TC", x: 810, y: 730, level: 3, from: "wt" }),
      node({ id: "dc", kind: "stack", label: "41 companies", sub: "Dormant · UK, BVI", glyph: "41", x: 1250, y: 730, level: 3, from: "pv" }),
    ],
    edges: [
      { id: "e1", s: "cn", t: "c", kind: "own", label: "62%" },
      { id: "e2", s: "hc", t: "c", kind: "own", label: "38%" },
      { id: "e3", s: "do", t: "c", kind: "ctrl", label: "Director" },
      { id: "e4", s: "ci", t: "cn", kind: "own", label: "80%" },
      { id: "e5", s: "wt", t: "cn", kind: "own", label: "20%" },
      { id: "e6", s: "uk", t: "hc", kind: "unknown", label: "?%" },
      { id: "e7", s: "pv", t: "hc", kind: "ctrl", label: "Director" },
      { id: "e8", s: "mc", t: "ci", kind: "own", label: "100%" },
      { id: "e9", s: "tc", t: "wt", kind: "ctrl", label: "Appointor" },
      { id: "e10", s: "pv", t: "dc", kind: "ctrl", label: "Directs" },
    ],
    string: {
      ids: ["mc", "ci", "cn", "c"],
      steps: [
        { eq: "Margaret Calder", value: "100%" },
        { eq: "100% × 80%", value: "80%" },
        { eq: "80% × 62%", value: "49.6%" },
      ],
      tag: { anchor: "mc", eq: "100% × 80% × 62% =", value: "49.6% · beneficial owner" },
    },
    ownerSub: { id: "mc", text: "Beneficial owner · 49.6%" },
    slip: {
      look: "review",
      lead: "Enhanced due diligence",
      title: "One owner found. One gap to close.",
      reasons: [
        { n: 1, node: "mc", text: "Margaret Calder owns 49.6% through two companies." },
        { n: 2, node: "hc", text: "38% sits with Halyard Capital Ltd (British Virgin Islands), whose owners are not on any register." },
        { n: 3, node: "pv", text: "Halyard’s director, Peter Voss, also directs 41 dormant companies." },
      ],
      next: "Next: ask for Halyard’s register of members.",
    },
  },
  {
    id: "trust",
    chip: "Trust over a company",
    name: "Wattle & Pine Property Trust",
    meta: "ABN 71 508 223 914 · VIC",
    nodes: [
      node({ id: "c", kind: "trust", client: true, label: "", sub: "ABN 71 508 223 914 · VIC", glyph: "T", x: 820, y: 250, level: 0 }),
      node({ id: "hl", kind: "person", label: "Henry Liu", sub: "Appointor", glyph: "HL", x: 560, y: 410, level: 1, from: "c", badge: 2 }),
      node({ id: "ct", kind: "company", label: "Corella Trustee Pty Ltd", sub: "ACN 633 101 287", glyph: "AU", x: 780, y: 410, level: 1, from: "c" }),
      node({ id: "lf", kind: "company", label: "Liu Family Co Pty Ltd", sub: "ACN 619 554 030", glyph: "AU", x: 1000, y: 410, level: 1, from: "c" }),
      node({ id: "om", kind: "person", label: "Owen Marsh", sub: "Unit holder", glyph: "OM", x: 1220, y: 410, level: 1, from: "c", badge: 3 }),
      node({ id: "gl", kind: "person", label: "Grace Liu", sub: "Director · shareholder", glyph: "GL", x: 890, y: 590, level: 2, from: "lf", badge: 1 }),
    ],
    edges: [
      { id: "e1", s: "ct", t: "c", kind: "ctrl", label: "Trustee" },
      { id: "e2", s: "hl", t: "c", kind: "ctrl", label: "Appointor" },
      { id: "e3", s: "lf", t: "c", kind: "own", label: "70%" },
      { id: "e4", s: "om", t: "c", kind: "own", label: "30%" },
      { id: "e5", s: "gl", t: "lf", kind: "own", label: "100%" },
      { id: "e6", s: "gl", t: "ct", kind: "ctrl", label: "Director" },
    ],
    string: {
      ids: ["gl", "lf", "c"],
      steps: [
        { eq: "Grace Liu", value: "100%" },
        { eq: "100% × 70%", value: "70%" },
      ],
      tag: { anchor: "gl", eq: "100% × 70% =", value: "70% · beneficial owner" },
    },
    ownerSub: { id: "gl", text: "Beneficial owner · 70%" },
    slip: {
      look: "review",
      lead: "Trust with a corporate trustee",
      title: "Three people to verify before you act.",
      reasons: [
        { n: 1, node: "gl", text: "Grace Liu holds 70% through Liu Family Co and directs the trustee company." },
        { n: 2, node: "hl", text: "Henry Liu can replace the trustee, so he controls the trust as appointor." },
        { n: 3, node: "om", text: "Owen Marsh holds 30% directly, above the 25% line." },
      ],
      next: "Next: send the client link for all three identities.",
    },
  },
  {
    id: "circle",
    chip: "Circular holding",
    name: "Tasman Ridge Pty Ltd",
    meta: "ACN 631 772 014 · QLD",
    nodes: [
      node({ id: "c", kind: "company", client: true, label: "", sub: "ACN 631 772 014 · QLD", glyph: "AU", x: 820, y: 250, level: 0 }),
      node({ id: "mh", kind: "person", label: "Marcus Hale", sub: "Director · shareholder", glyph: "MH", x: 600, y: 410, level: 1, from: "c", badge: 2 }),
      node({ id: "wc", kind: "company", label: "Westerly Capital Ltd", sub: "NZBN 9429 0473 1182", glyph: "NZ", x: 860, y: 410, level: 1, from: "c", badge: 3 }),
      node({ id: "ol", kind: "company", label: "Orchard Lane Investments Pty Ltd", sub: "ACN 629 115 830", flags: [{ text: "◆ Part of a circular holding", level: "review" }], x: 760, y: 570, level: 2, from: "wc", glyph: "AU", badge: 1 }),
      node({ id: "hw", kind: "person", label: "Hemi Walker", sub: "Shareholder", glyph: "HW", x: 1010, y: 570, level: 2, from: "wc" }),
      node({ id: "pa", kind: "person", label: "Priya Anand", sub: "Shareholder", glyph: "PA", x: 760, y: 730, level: 3, from: "ol" }),
    ],
    edges: [
      { id: "e1", s: "mh", t: "c", kind: "own", label: "50%" },
      { id: "e2", s: "wc", t: "c", kind: "own", label: "50%" },
      { id: "e3", s: "ol", t: "wc", kind: "own", label: "70%" },
      { id: "e4", s: "hw", t: "wc", kind: "own", label: "30%" },
      { id: "e5", s: "c", t: "ol", kind: "own", label: "Circular · 60% ↺", curve: true },
      { id: "e6", s: "pa", t: "ol", kind: "own", label: "40%" },
    ],
    string: { ids: ["mh", "c"], steps: [{ eq: "Marcus Hale", value: "50%" }], tag: { anchor: "mh", eq: "direct =", value: "50% · beneficial owner" } },
    ownerSub: { id: "mh", text: "Beneficial owner · 50%" },
    slip: {
      look: "high",
      lead: "Enhanced due diligence",
      title: "Ownership loops back on itself.",
      reasons: [
        { n: 1, node: "ol", text: "Tasman Ridge owns 60% of Orchard Lane, which owns 70% of Westerly Capital, which owns half of Tasman Ridge." },
        { n: 2, node: "mh", text: "Marcus Hale owns the other 50% directly." },
        { n: 3, node: "wc", text: "The loop runs through New Zealand, so registers sit in two countries." },
      ],
      next: "Next: ask for both companies’ registers of members.",
    },
  },
  {
    id: "nominee",
    chip: "Nominee directors",
    name: "Lumen Trade Pty Ltd",
    meta: "ACN 640 551 207 · NSW",
    nodes: [
      node({ id: "c", kind: "company", client: true, label: "", sub: "ACN 640 551 207 · NSW", glyph: "AU", x: 820, y: 250, level: 0 }),
      node({ id: "gp", kind: "person", label: "Gregory Pell", sub: "Director", glyph: "GP", flags: [{ text: "▲ 41 dormant companies", level: "high" }], x: 620, y: 420, level: 1, from: "c", badge: 2 }),
      node({ id: "sn", kind: "company", label: "Seaview Nominees Ltd", sub: "Seychelles", glyph: "SC", flags: [{ text: "◆ Owners not disclosed", level: "review" }], x: 980, y: 420, level: 1, from: "c", badge: 1 }),
      node({ id: "st", kind: "stack", label: "41 companies", sub: "Dormant · SC, VG, GB", glyph: "41", x: 620, y: 600, level: 2, from: "gp" }),
      node({ id: "uk", kind: "unknown", label: "Unknown shareholders", sub: "1 or more", glyph: "?", x: 980, y: 600, level: 2, from: "sn" }),
      node({ id: "ad", kind: "address", label: "Suite 4, 88 Victoria St, Mahé", sub: "Shared by 3 of your clients", glyph: "⌂", x: 800, y: 760, level: 3, from: "st", badge: 3 }),
    ],
    edges: [
      { id: "e1", s: "gp", t: "c", kind: "ctrl", label: "Director" },
      { id: "e2", s: "sn", t: "c", kind: "own", label: "100%" },
      { id: "e3", s: "gp", t: "st", kind: "ctrl", label: "Directs" },
      { id: "e4", s: "uk", t: "sn", kind: "unknown", label: "?%" },
      { id: "e5", s: "ad", t: "st", kind: "faint" },
      { id: "e6", s: "ad", t: "sn", kind: "faint" },
    ],
    string: { ids: ["gp", "c"], steps: [{ eq: "Gregory Pell", value: "Director" }], tag: { anchor: "gp", eq: "controls as", value: "director · no owner found" } },
    slip: {
      look: "high",
      lead: "Enhanced due diligence",
      title: "No owner found. One director to explain.",
      reasons: [
        { n: 1, node: "sn", text: "Seaview Nominees Ltd in the Seychelles owns 100%, and its owners are not disclosed." },
        { n: 2, node: "gp", text: "Gregory Pell directs 41 dormant companies, a common sign of a nominee." },
        { n: 3, node: "ad", text: "Three of your clients share his office address in Mahé." },
      ],
      next: "Next: ask who gives Mr Pell his instructions.",
    },
  },
];
