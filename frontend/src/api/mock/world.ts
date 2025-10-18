// Offline fixture world: Harbourline Legal (Sydney), built to the demo seed in docs/API_CONTRACT.md Part 5.
// All data is synthetic. Dates are relative to today at runtime, never fixed calendar dates.
import { daysFromToday, isoDate } from "../../lib/dates";
import { ROLE_LABELS } from "../../lib/permissions";
import type {
  Alert,
  AuditEntry,
  Case,
  Client,
  ClientFlag,
  Consent,
  DocumentRec,
  Edd,
  Insight,
  Invitation,
  ListEntry,
  MatchCandidate,
  MatchReason,
  Member,
  Methodology,
  Org,
  OrgSettings,
  Rating,
  Relationship,
  Role,
  RiskAssessment,
  RiskReason,
  ScreeningHit,
  SmrDraft,
  TrainingRecord,
  User,
} from "../types";
import type { WParty, WorldGraph } from "./graphcalc";

const ago = (n: number) => daysFromToday(-n);
const ahead = (n: number) => daysFromToday(n);
const stamp = (daysBack: number, hh = 10, mm = 0) => {
  const d = new Date();
  d.setDate(d.getDate() - daysBack);
  d.setHours(hh, mm, 0, 0);
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const pad = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, "0");
  return `${isoDate(d)}T${pad(hh)}:${pad(mm)}:00${sign}${pad(off / 60)}:${pad(off % 60)}`;
};

export interface DemoUser extends User {
  password: string;
}
export interface Membership {
  userId: string;
  orgId: string;
  role: Role;
  joinedAt: string;
}

export interface World extends WorldGraph {
  org: Org;
  settings: OrgSettings;
  members: Membership[];
  invitations: (Invitation & { token: string })[];
  candidates: MatchCandidate[];
  listEntries: ListEntry[];
  hits: ScreeningHit[];
  assessments: RiskAssessment[];
  edd: Record<string, Edd>;
  alerts: Alert[];
  cases: (Case & { access: NonNullable<Case["access"]> })[];
  smr: Record<string, SmrDraft>;
  caseTimeline: Record<string, { at: string; actorName: string; action: string; label: string }[]>;
  audit: AuditEntry[];
  training: TrainingRecord[];
  methodologies: Methodology[];
  documents: Record<string, DocumentRec[]>;
  consents: Consent[];
  insights: Insight[];
  reviewsDone: Record<string, string>;
}

export const USERS: DemoUser[] = [
  { id: "u-olivia", email: "olivia@harbourline.example", fullName: "Olivia Grant", avatarColor: "#3A4146", createdAt: stamp(420), password: "Kinroot-demo-2025!" },
  { id: "u-daniel", email: "daniel@harbourline.example", fullName: "Daniel Cho", avatarColor: "#9B1C31", createdAt: stamp(420), password: "Kinroot-demo-2025!" },
  { id: "u-margaret", email: "margaret@harbourline.example", fullName: "Margaret Ellis", avatarColor: "#2F6B4F", createdAt: stamp(410), password: "Kinroot-demo-2025!" },
  { id: "u-tom", email: "tom@harbourline.example", fullName: "Tom Nguyen", avatarColor: "#8A6100", createdAt: stamp(400), password: "Kinroot-demo-2025!" },
  { id: "u-aisha", email: "aisha@harbourline.example", fullName: "Aisha Karim", avatarColor: "#353B40", createdAt: stamp(380), password: "Kinroot-demo-2025!" },
  { id: "u-ruth", email: "ruth@harbourline.example", fullName: "Ruth Adeyemi", avatarColor: "#586064", createdAt: stamp(200), password: "Kinroot-demo-2025!" },
  { id: "u-priya", email: "priya@northgate.example", fullName: "Priya Raman", avatarColor: "#7E1527", createdAt: stamp(300), password: "Kinroot-demo-2025!" },
];
export const userById = (id: string) => USERS.find((u) => u.id === id)!;

export const ORGS: Org[] = [
  {
    id: "org-harbourline",
    name: "Harbourline Legal (Sydney)",
    slug: "harbourline",
    country: "AU",
    abn: "41 624 118 902",
    address: "Level 9, 1 Barangaroo Ave, Barangaroo NSW 2000",
    sector: "legal",
    regime: { name: "AML/CTF Act 2006 (Cth), Tranche 2", commencement: "2026-07-01" },
    dataResidency: "AU",
    createdAt: stamp(420),
  },
  {
    id: "org-northgate",
    name: "Northgate Accountants (London)",
    slug: "northgate",
    country: "GB",
    abn: "",
    address: "14 Northgate Yard, London EC2A 4PL",
    sector: "accounting",
    regime: { name: "UK MLR 2017", commencement: null },
    dataResidency: "UK",
    createdAt: stamp(300),
  },
];

export function buildWorld(orgId = "org-harbourline"): World {
  return orgId === "org-northgate" ? buildNorthgate() : buildHarbourline();
}

// ---------------------------------------------------------------- builders
function makeBuilders() {
  const parties: Record<string, WParty> = {};
  const rels: Relationship[] = [];
  let n = 0;
  const party = (id: string, kind: WParty["kind"], name: string, o: Partial<WParty> = {}): string => {
    parties[id] = { id, kind, name, identifiers: {}, isNominee: false, source: "seed", mergedInto: null, createdAt: stamp(400), flags: [], ...o };
    return id;
  };
  type RelOpts = { id?: string; from?: string; to?: string | null; interest?: string; note?: string; nominee?: boolean; source?: string };
  const rel = (kind: "ownership" | "control", from: string, to: string, value: number | string | null, o: RelOpts = {}) => {
    n += 1;
    rels.push({
      id: o.id ?? `r-${String(n).padStart(3, "0")}`,
      fromPartyId: from,
      toPartyId: to,
      kind,
      pct: kind === "ownership" && typeof value === "number" ? value : undefined,
      role: kind === "control" ? String(value) : undefined,
      interest: o.interest ?? (kind === "ownership" ? "shares" : undefined),
      nominee: o.nominee ?? false,
      validFrom: o.from ?? ago(900),
      validTo: o.to ?? null,
      source: o.source ?? "register extract",
      sourceRef: o.source ?? "ASIC extract",
      evidenceNote: o.note,
      createdAt: stamp(400),
    });
  };
  const own = (from: string, to: string, pct: number | null, o: RelOpts = {}) => rel("ownership", from, to, pct, o);
  const ctl = (from: string, to: string, role: string, o: RelOpts = {}) => rel("control", from, to, role, o);
  return { parties, rels, party, own, ctl };
}

function harbourlineClients(): { g: ReturnType<typeof makeBuilders>; clients: Client[]; addressLinks: WorldGraph["addressLinks"] } {
  const g = makeBuilders();
  const { party: P, own, ctl } = g;
  const co = (id: string, name: string, juris: string, ident: WParty["identifiers"] = {}, o: Partial<WParty> = {}) => P(id, "company", name, { jurisdiction: juris, identifiers: ident, ...o });
  const person = (id: string, name: string, birth: string, nat = "AU", o: Partial<WParty> = {}) => P(id, "person", name, { birthDate: birth, nationality: nat, ...o });

  // 1–3 Harbour Quay group: trust over company over offshore holding
  co("p-harbour-quay", "Harbour Quay Developments Pty Ltd", "AU", { acn: "614 203 778" });
  co("p-kestrel-ventures", "Kestrel Ventures Ltd", "VG", { ukCompanyNumber: "BVI 1874402" }, { flags: ["offshore", "unknown_owner"] });
  co("p-bellmere", "Bellmere Holdings Pty Ltd", "AU", { acn: "602 118 405" });
  P("p-calder-trust", "trust", "Calder Family Trust", { jurisdiction: "AU", identifiers: { abn: "33 604 512 118" } });
  co("p-calder-trustee", "Calder Trustee Co Pty Ltd", "AU", { acn: "151 377 920" });
  person("p-ava-calder", "Ava Calder", "1968-03-14", "AU", { address: "22 Wolseley Rd, Point Piper NSW 2027" });
  person("p-ben-okafor", "Ben Okafor", "1975-09-02", "AU", { address: "8 Bay St, Double Bay NSW 2028" });
  person("p-daniel-okoro", "Daniel Okoro", "1979-01-21", "AU");
  person("p-marisol-duarte", "Marisol Duarte", "1971-06-30", "PA", { isNominee: true, sub: "Nominee director" });
  person("p-ana-ruiz", "Ana Ruiz", "1966-11-12", "ES");
  person("p-edmund-hartley", "Edmund Hartley", "1962-04-18", "GB");
  P("p-duarte-stack", "stack", "23 companies", { count: 23, sub: "Directorships · PA, VG", dormant: true });
  own("p-kestrel-ventures", "p-harbour-quay", 100, { id: "r-hq-kestrel", from: ago(1400) });
  own("p-bellmere", "p-kestrel-ventures", 80, { id: "r-kestrel-bellmere", from: ago(1400), source: "BVI register extract" });
  own("p-calder-trust", "p-bellmere", 62, { id: "r-bellmere-trust", from: ago(1600) });
  own("p-ben-okafor", "p-bellmere", 38, { id: "r-bellmere-ben", from: ago(1600) });
  own("p-ava-calder", "p-calder-trust", 100, { id: "r-trust-ava", interest: "beneficial interest", source: "trust deed" });
  ctl("p-calder-trustee", "p-calder-trust", "Trustee", { id: "r-trust-trustee", source: "trust deed" });
  ctl("p-ava-calder", "p-calder-trust", "Appointor", { id: "r-trust-appointor", source: "trust deed" });
  ctl("p-ava-calder", "p-calder-trustee", "Director", { id: "r-trustee-ava" });
  ctl("p-daniel-okoro", "p-harbour-quay", "Director", { id: "r-hq-okoro" });
  ctl("p-ana-ruiz", "p-kestrel-ventures", "Director", { id: "r-kestrel-ruiz", to: ago(64), source: "BVI register extract" });
  ctl("p-marisol-duarte", "p-kestrel-ventures", "Director", { id: "r-kestrel-duarte", from: ago(64), nominee: true, source: "BVI register extract" });
  ctl("p-marisol-duarte", "p-duarte-stack", "Directs", { id: "r-duarte-stack" });
  ctl("p-edmund-hartley", "p-kestrel-ventures", "Secretary", { id: "r-kestrel-hartley" });

  // 4–5 Circular ownership
  co("p-tasman-ridge", "Tasman Ridge Pty Ltd", "AU", { acn: "631 772 014" });
  co("p-orchard-lane", "Orchard Lane Investments Pty Ltd", "AU", { acn: "629 115 830" });
  co("p-westerly", "Westerly Capital Ltd", "NZ", { ukCompanyNumber: "NZBN 9429 0473 1182" }, { flags: ["offshore"] });
  person("p-marcus-hale", "Marcus Hale", "1970-08-08");
  person("p-hemi-walker", "Hemi Walker", "1981-02-19", "NZ");
  person("p-priya-anand", "Priya Anand", "1983-12-05");
  own("p-marcus-hale", "p-tasman-ridge", 50, { id: "r-tr-hale" });
  own("p-westerly", "p-tasman-ridge", 50, { id: "r-tr-westerly" });
  own("p-orchard-lane", "p-westerly", 70, { id: "r-westerly-orchard" });
  own("p-hemi-walker", "p-westerly", 30, { id: "r-westerly-walker" });
  own("p-tasman-ridge", "p-orchard-lane", 60, { id: "r-orchard-tr" });
  own("p-priya-anand", "p-orchard-lane", 40, { id: "r-orchard-anand" });
  ctl("p-marcus-hale", "p-tasman-ridge", "Director");

  // 6–8 Nominee-director cluster
  person("p-gregory-pell", "Gregory Pell", "1958-10-27", "SC", { isNominee: true, address: "Suite 4, 88 Victoria St, Mahé, Seychelles", flags: ["high_risk_jurisdiction"] });
  P("p-pell-stack", "stack", "41 companies", { count: 41, sub: "Dormant · SC, VG, GB", dormant: true });
  ctl("p-gregory-pell", "p-pell-stack", "Directs", { id: "r-pell-stack" });
  P("p-addr-mahe", "address", "Suite 4, 88 Victoria St, Mahé");
  P("p-addr-pitt", "address", "Level 3, 120 Pitt St, Sydney");
  co("p-lumen-trade", "Lumen Trade Pty Ltd", "AU", { acn: "640 551 207" });
  co("p-seaview-nominees", "Seaview Nominees Ltd", "SC", {}, { flags: ["offshore", "unknown_owner", "high_risk_jurisdiction"] });
  own("p-seaview-nominees", "p-lumen-trade", 100, { id: "r-lumen-seaview" });
  ctl("p-gregory-pell", "p-lumen-trade", "Director", { id: "r-lumen-pell", nominee: true });
  co("p-silverbirch", "Silverbirch Imports Pty Ltd", "AU", { acn: "638 904 116" });
  person("p-odile-ferrand", "Odile Ferrand", "1977-05-03", "FR");
  own("p-odile-ferrand", "p-silverbirch", 100, { id: "r-silver-ferrand" });
  ctl("p-gregory-pell", "p-silverbirch", "Director", { id: "r-silver-pell", nominee: true });
  co("p-coralline", "Coralline Logistics Pty Ltd", "AU", { acn: "644 019 552" });
  person("p-jack-moreau", "Jack Moreau", "1984-07-11");
  person("p-lena-ostrova", "Lena Ostrova", "1986-01-29");
  own("p-jack-moreau", "p-coralline", 50);
  own("p-lena-ostrova", "p-coralline", 50);
  ctl("p-gregory-pell", "p-coralline", "Director", { nominee: true });

  // 9 Sanctions near-match #1 (likely true match)
  co("p-aurelian-shipping", "Aurelian Shipping Pty Ltd", "AU", { acn: "652 330 418" });
  co("p-aurelian-fze", "Aurelian Maritime FZE", "AE", {}, { flags: ["offshore", "sanctions_hit"] });
  person("p-yusuf-karimov", "Yusuf Karimov", "1969-03-22", "AE");
  person("p-rashid-mansoori", "Rashid Al-Mansoori", "1965-09-14", "AE");
  own("p-aurelian-fze", "p-aurelian-shipping", 100, { id: "r-aurelian-fze" });
  own("p-rashid-mansoori", "p-aurelian-fze", 100, { id: "r-fze-rashid", source: "client document" });
  ctl("p-yusuf-karimov", "p-aurelian-shipping", "Director", { id: "r-aurelian-karimov" });
  ctl("p-yusuf-karimov", "p-aurelian-fze", "Manager", { id: "r-fze-karimov" });

  // 10–12 individuals and PEP
  person("p-alexei-petrov", "Alexei Petrov", "1988-04-17", "AU");
  person("p-julian-whitfield", "Hon. Julian Whitfield", "1961-07-09", "AU", { flags: ["pep"] });
  P("p-whitfield-smsf", "trust", "Whitfield Family Super Fund", { jurisdiction: "AU", identifiers: { abn: "71 558 203 994" } });
  co("p-whitfield-super", "Whitfield Super Pty Ltd", "AU", { acn: "609 448 201" });
  person("p-claire-whitfield", "Claire Whitfield", "1964-02-25");
  own("p-julian-whitfield", "p-whitfield-smsf", 60, { interest: "member balance" });
  own("p-claire-whitfield", "p-whitfield-smsf", 40, { interest: "member balance" });
  ctl("p-whitfield-super", "p-whitfield-smsf", "Trustee");
  ctl("p-julian-whitfield", "p-whitfield-super", "Director");

  // 13 partnership
  P("p-ferris-wu", "partnership", "Ferris & Wu Partners", { jurisdiction: "AU", identifiers: { abn: "18 337 902 541" } });
  person("p-helen-ferris", "Helen Ferris", "1972-06-01");
  person("p-david-wu", "David Wu", "1974-11-19");
  person("p-sana-iqbal", "Sana Iqbal", "1985-03-08");
  own("p-helen-ferris", "p-ferris-wu", 34, { interest: "partnership share" });
  own("p-david-wu", "p-ferris-wu", 33, { interest: "partnership share" });
  own("p-sana-iqbal", "p-ferris-wu", 33, { interest: "partnership share" });

  co("p-brightwater", "Brightwater Realty Pty Ltd", "AU", { acn: "611 902 337" });
  person("p-grant-lowe", "Grant Lowe", "1976-10-10");
  own("p-grant-lowe", "p-brightwater", 100);
  ctl("p-grant-lowe", "p-brightwater", "Director");

  person("p-linh-nguyen", "Linh Nguyen", "1990-05-14");
  person("p-lin-nguyen", "Lin Nguyen", "1993-08-30");
  person("p-sean-oconnor", "Sean O'Connor", "1987-12-03", "IE");
  person("p-sean-oconnor-2", "Sean OConnor", "1987-12-03", "IE", { mergedInto: "p-sean-oconnor", source: "manual" });
  person("p-riya-patel", "Riya Patel", "1982-09-21");

  // 18 Harrow: officer change
  co("p-harrow-mining", "Harrow Mining Services Pty Ltd", "AU", { acn: "603 771 248" });
  co("p-harrow-holdings", "Harrow Holdings Pty Ltd", "AU", { acn: "603 770 991" });
  co("p-westpoint-super", "Westpoint Super Pty Ltd", "AU", { acn: "155 208 664" });
  person("p-fiona-harrow", "Fiona Harrow", "1969-01-15");
  person("p-keith-barlow", "Keith Barlow", "1957-05-27");
  person("p-nadia-petrenko", "Nadia Petrenko", "1980-10-02", "UA");
  own("p-harrow-holdings", "p-harrow-mining", 100);
  own("p-fiona-harrow", "p-harrow-holdings", 70);
  own("p-westpoint-super", "p-harrow-holdings", 30);
  own("p-fiona-harrow", "p-westpoint-super", 100, { interest: "member balance" });
  ctl("p-keith-barlow", "p-harrow-mining", "Director", { id: "r-harrow-barlow", to: ago(41) });
  ctl("p-nadia-petrenko", "p-harrow-mining", "Director", { id: "r-harrow-petrenko", from: ago(41) });

  // 19 UK parent, shared officer with Kestrel Ventures
  co("p-kestrel-uk", "Kestrel Holdings (UK) Ltd", "GB", { ukCompanyNumber: "11834207" });
  own("p-edmund-hartley", "p-kestrel-uk", 75, { source: "Companies House PSC" });
  ctl("p-edmund-hartley", "p-kestrel-uk", "Director", { source: "Companies House" });
  person("p-lucy-hartley", "Lucy Hartley", "1990-02-02", "GB");
  own("p-lucy-hartley", "p-kestrel-uk", 25, { source: "Companies House PSC" });

  co("p-blue-gum", "Blue Gum Childcare Ltd", "AU", { acn: "622 410 905" });
  person("p-jane-morrow", "Jane Morrow", "1966-04-04");
  person("p-ravi-sharma", "Ravi Sharma", "1979-07-17");
  ctl("p-jane-morrow", "p-blue-gum", "Chair (senior managing official)");
  ctl("p-ravi-sharma", "p-blue-gum", "Chief executive");

  co("p-marlowe-art", "Marlowe Fine Art Pty Ltd", "AU", { acn: "617 552 093" });
  person("p-felix-marlowe", "Felix Marlowe", "1973-03-30");
  own("p-felix-marlowe", "p-marlowe-art", 100);
  ctl("p-felix-marlowe", "p-marlowe-art", "Director");

  person("p-kenji-sato", "Kenji Sato", "1979-06-06", "JP");

  P("p-delacroix", "trust", "Delacroix Unit Trust", { jurisdiction: "AU", identifiers: { abn: "52 811 470 213" } });
  co("p-delacroix-nominees", "Delacroix Nominees Pty Ltd", "AU", { acn: "620 337 115" });
  person("p-clement-delacroix", "Clément Delacroix", "1960-12-12", "FR");
  person("p-mira-delacroix", "Mira Delacroix", "1992-01-08");
  person("p-oscar-delacroix", "Oscar Delacroix", "1994-05-19");
  own("p-clement-delacroix", "p-delacroix", 34, { interest: "units" });
  own("p-mira-delacroix", "p-delacroix", 33, { interest: "units" });
  own("p-oscar-delacroix", "p-delacroix", 33, { interest: "units" });
  ctl("p-delacroix-nominees", "p-delacroix", "Trustee");
  ctl("p-clement-delacroix", "p-delacroix-nominees", "Director");

  co("p-northshore", "Northshore Dental Group Pty Ltd", "AU", { acn: "609 223 870" });
  person("p-amelia-ross", "Dr Amelia Ross", "1980-09-09");
  person("p-kwame-mensah", "Dr Kwame Mensah", "1978-11-23");
  own("p-amelia-ross", "p-northshore", 50);
  own("p-kwame-mensah", "p-northshore", 50);
  P("p-addr-northshore", "address", "Level 3, 120 Pitt St, Sydney");

  // 25 Ironbark: ownership change via a Cayman entity
  co("p-ironbark", "Ironbark Ventures Pty Ltd", "AU", { acn: "648 102 557" });
  person("p-owen-pryce", "Owen Pryce", "1971-02-14");
  co("p-cayman-crest", "Cayman Crest Holdings Ltd", "KY", {}, { flags: ["offshore", "unknown_owner"] });
  own("p-owen-pryce", "p-ironbark", 100, { id: "r-ironbark-pryce-old", to: ago(29) });
  own("p-owen-pryce", "p-ironbark", 60, { id: "r-ironbark-pryce", from: ago(29) });
  own("p-cayman-crest", "p-ironbark", 40, { id: "r-ironbark-cayman", from: ago(29), source: "client document" });
  ctl("p-owen-pryce", "p-ironbark", "Director");

  // 26 duplicate person across structures
  co("p-greenfield", "Greenfield Estates Pty Ltd", "AU", { acn: "635 880 412" });
  person("p-benjamin-okafor", "Benjamin Okafor", "1975-09-02", "AU", { address: "41 Cove St, Watsons Bay NSW 2030" });
  own("p-benjamin-okafor", "p-greenfield", 100);
  ctl("p-benjamin-okafor", "p-greenfield", "Director");

  person("p-murray-chen", "Murray Chen", "1985-10-01");
  person("p-murray-cheng", "Murray Cheng", "1989-03-17");

  co("p-southbank", "Southbank Holdings Pty Ltd", "AU", { acn: "627 441 096" }, { flags: ["unknown_owner"] });
  person("p-lucas-bennett", "Lucas Bennett", "1977-07-07");
  own("p-lucas-bennett", "p-southbank", 70);
  ctl("p-lucas-bennett", "p-southbank", "Director");

  P("p-lim-trust", "trust", "Lim Family Trust", { jurisdiction: "AU" });
  person("p-wei-lim", "Wei Lim", "1963-08-18");
  person("p-mei-lim", "Mei Lim", "1995-02-10");
  person("p-jun-lim", "Jun Lim", "1997-06-24");
  ctl("p-wei-lim", "p-lim-trust", "Trustee");
  own("p-mei-lim", "p-lim-trust", 50, { interest: "fixed entitlement" });
  own("p-jun-lim", "p-lim-trust", 50, { interest: "fixed entitlement" });

  P("p-coastal", "partnership", "Coastal Conveyancing Co", { jurisdiction: "AU" });
  person("p-paula-grey", "Paula Grey", "1959-04-01");
  person("p-neil-pascoe", "Neil Pascoe", "1961-09-15");
  own("p-paula-grey", "p-coastal", 50, { interest: "partnership share" });
  own("p-neil-pascoe", "p-coastal", 50, { interest: "partnership share" });

  // Pyrmont: a person on file twice (record found while onboarding) for the fuse queue
  co("p-pyrmont-wharf", "Pyrmont Wharf Pty Ltd", "AU", { acn: "618 940 225" });
  person("p-jonathan-reyes", "Jonathan P. Reyes", "1971-02-14", "AU", { address: "12 Wharf St, Pyrmont NSW 2009", identifiers: { passport: "PA··4471" } });
  person("p-jonathon-reyes", "Jonathon Reyes", "1971-02-14", "AU", { address: "12 Wharf Street, Pyrmont", source: "manual" });
  ctl("p-jonathan-reyes", "p-bellmere", "Director", { from: ago(700) });
  own("p-jonathan-reyes", "p-pyrmont-wharf", 15);
  ctl("p-jonathon-reyes", "p-pyrmont-wharf", "Director");
  person("p-greg-pell", "Greg Pell", "1958-10-27", "SC", { address: "88 Victoria Street, Victoria, Mahé", source: "manual" });
  ctl("p-greg-pell", "p-silverbirch", "Secretary", { from: ago(20) });
  person("p-ava-m-calder", "Ava M. Calder", "1968-03-14", "AU", { address: "22 Wolseley Road, Point Piper", source: "manual" });
  own("p-ava-m-calder", "p-marlowe-art", null, { from: ago(12), interest: "loan note", source: "client document" });

  const addressLinks = [
    { partyId: "p-lumen-trade", addressId: "p-addr-mahe" },
    { partyId: "p-silverbirch", addressId: "p-addr-mahe" },
    { partyId: "p-coralline", addressId: "p-addr-mahe" },
    { partyId: "p-coralline", addressId: "p-addr-pitt" },
    { partyId: "p-lumen-trade", addressId: "p-addr-pitt" },
  ];

  type CO = Partial<Client> & { onboardedDaysAgo?: number; reviewInDays?: number };
  const tom = { id: "u-tom", fullName: "Tom Nguyen" };
  const aisha = { id: "u-aisha", fullName: "Aisha Karim" };
  const margaret = { id: "u-margaret", fullName: "Margaret Ellis" };
  let seq = 100;
  const mk = (key: string, partyId: string, kind: Client["kind"], rating: Rating | null, flags: ClientFlag[], o: CO = {}): Client => {
    seq += 7;
    const onb = o.onboardedDaysAgo ?? 200 + (seq % 160);
    const months = rating === "high" ? 12 : rating === "medium" ? 24 : 36;
    return {
      id: `c-${key}`,
      kind,
      name: g.parties[partyId]!.name,
      status: "active",
      jurisdiction: g.parties[partyId]!.jurisdiction ?? "AU",
      partyId,
      services: ["property_transaction"],
      channel: "face_to_face",
      matterReference: `HL-${new Date().getFullYear()}-0${seq}`,
      assignedTo: seq % 2 ? tom : aisha,
      rating,
      ratingSource: rating ? "rules" : null,
      eddRequired: rating === "high",
      onboardedOn: ago(onb),
      lastReviewedOn: ago(onb),
      nextReviewOn: o.reviewInDays != null ? ahead(o.reviewInDays) : ahead(Math.max(20, months * 30 - onb)),
      structure: { parties: 1, layers: 0, ubos: 0 },
      flags,
      createdAt: stamp(onb),
      updatedAt: stamp(3),
      sample: true,
      ...o,
    };
  };
  const clients: Client[] = [
    mk("harbour-quay", "p-harbour-quay", "company", "high", ["offshore", "nominee"], { onboardedDaysAgo: 255, services: ["property_transaction", "managing_client_funds"], assignedTo: tom, reviewInDays: 110 }),
    mk("bellmere", "p-bellmere", "company", "medium", [], { onboardedDaysAgo: 240 }),
    mk("calder-trust", "p-calder-trust", "trust", "medium", [], { services: ["trust_formation"], assignedTo: margaret }),
    mk("tasman-ridge", "p-tasman-ridge", "company", "high", ["circular", "offshore"], { reviewInDays: 18 }),
    mk("orchard-lane", "p-orchard-lane", "company", "medium", ["circular"]),
    mk("lumen-trade", "p-lumen-trade", "company", "high", ["nominee", "offshore"], { services: ["company_formation"] }),
    mk("silverbirch", "p-silverbirch", "company", "high", ["nominee"], { services: ["company_formation"] }),
    mk("coralline", "p-coralline", "company", "medium", ["nominee"]),
    mk("aurelian-shipping", "p-aurelian-shipping", "company", "high", ["sanctions_review", "offshore"], { services: ["managing_client_funds"], channel: "remote" }),
    mk("petrov-alexei", "p-alexei-petrov", "individual", "low", ["sanctions_review"], { services: ["conveyancing"] }),
    mk("whitfield-julian", "p-julian-whitfield", "individual", "high", ["pep"], { services: ["property_transaction"], assignedTo: margaret }),
    mk("whitfield-family", "p-whitfield-smsf", "trust", "medium", ["pep"], { services: ["tax_advice"] }),
    mk("ferris-wu", "p-ferris-wu", "partnership", "low", [], { services: ["audit"] }),
    mk("brightwater-re", "p-brightwater", "company", "low", [], { services: ["real_estate_sale"] }),
    mk("nguyen-linh", "p-linh-nguyen", "individual", "low", [], { services: ["conveyancing"], channel: "remote" }),
    mk("oconnor-sean", "p-sean-oconnor", "individual", "low", [], { services: ["conveyancing"] }),
    mk("patel-riya", "p-riya-patel", "individual", "low", ["review_overdue"], { services: ["conveyancing"], reviewInDays: -40, onboardedDaysAgo: 1135 }),
    mk("harrow-mining", "p-harrow-mining", "company", "medium", [], { services: ["managing_client_funds"] }),
    mk("kestrel-holdings-uk", "p-kestrel-uk", "company", "medium", ["offshore"]),
    mk("blue-gum", "p-blue-gum", "company", "low", []),
    mk("marlowe-art", "p-marlowe-art", "company", "medium", [], { services: ["other"], reviewInDays: 10 }),
    mk("sato-kenji", "p-kenji-sato", "individual", "medium", [], { channel: "remote", services: ["property_transaction"] }),
    mk("delacroix-trust", "p-delacroix", "trust", "medium", [], { services: ["trust_formation"], reviewInDays: -12, onboardedDaysAgo: 742 }),
    mk("northshore-dental", "p-northshore", "company", "low", [], { services: ["tax_advice"], reviewInDays: 24 }),
    mk("ironbark-ventures", "p-ironbark", "company", "high", ["offshore"], { reviewInDays: 26 }),
    mk("greenfield-estates", "p-greenfield", "company", "medium", [], { reviewInDays: -7, onboardedDaysAgo: 737 }),
    mk("murray-chen", "p-murray-chen", "individual", "low", [], { services: ["conveyancing"] }),
    mk("southbank-holdings", "p-southbank", "company", "high", [], { services: ["property_transaction"], reviewInDays: 29 }),
    mk("lim-family", "p-lim-trust", "trust", null, [], { status: "onboarding", onboardedOn: null, lastReviewedOn: null, nextReviewOn: null, services: ["trust_formation"], eddRequired: false }),
    mk("coastal-conveyancing", "p-coastal", "partnership", "low", [], { status: "exited", nextReviewOn: null, onboardedDaysAgo: 2400 }),
  ];
  return { g, clients, addressLinks };
}

function reason(code: string, factor: RiskReason["factor"], points: number, message: string, evidence: RiskReason["evidence"] = []): RiskReason {
  return { code, factor, points, message, evidence };
}
const mr = (feature: string, label: string, contribution: number, value: number | string | null = null): MatchReason => ({
  feature,
  label,
  direction: contribution >= 0 ? "for" : "against",
  contribution,
  value,
});

const REASONS: Record<string, RiskReason[]> = {
  "harbour-quay": [
    reason("UNKNOWN_OWNER", "structure", 20, "20% of Kestrel Ventures Ltd is held by owners who are not on any register.", [{ type: "node", id: "p-kestrel-ventures" }]),
    reason("OFFSHORE_LAYER", "jurisdiction", 18, "All of the client is owned through Kestrel Ventures Ltd in the British Virgin Islands.", [{ type: "edge", id: "r-hq-kestrel" }]),
    reason("NOMINEE_DIRECTOR", "structure", 15, "Kestrel's new director also directs 23 other companies, a common sign of a nominee.", [{ type: "edge", id: "r-kestrel-duarte" }]),
    reason("LAYERS", "structure", 12, "Ownership passes through three companies and a discretionary trust before it reaches a person.", [
      { type: "edge", id: "r-kestrel-bellmere" },
      { type: "edge", id: "r-bellmere-trust" },
    ]),
    reason("CLIENT_FUNDS", "service", 10, "The matter involves holding client money for a property development.", []),
    reason("ID_VERIFIED", "customer", -5, "Both beneficial owners have verified identity documents on file.", [{ type: "edge", id: "r-trust-ava" }]),
  ],
  bellmere: [
    reason("LAYERS", "structure", 12, "Ownership passes through a discretionary trust before it reaches a person.", [{ type: "edge", id: "r-bellmere-trust" }]),
    reason("TRUST", "structure", 10, "A trust with a corporate trustee sits in the structure.", [{ type: "edge", id: "r-trust-trustee" }]),
    reason("CLIENT_FUNDS", "service", 10, "The matter involves holding client money.", []),
    reason("ID_VERIFIED", "customer", -4, "Both beneficial owners have verified identity documents on file.", []),
  ],
  "tasman-ridge": [
    reason("CIRCULAR", "structure", 25, "Ownership loops back on itself through Orchard Lane and Westerly Capital: 30% is held in a circle.", [
      { type: "edge", id: "r-orchard-tr" },
      { type: "edge", id: "r-westerly-orchard" },
      { type: "edge", id: "r-tr-westerly" },
    ]),
    reason("OFFSHORE_LAYER", "jurisdiction", 12, "Half the client is held through Westerly Capital Ltd in New Zealand.", [{ type: "edge", id: "r-tr-westerly" }]),
    reason("LAYERS", "structure", 8, "Two of three owners sit behind company layers.", []),
    reason("ID_VERIFIED", "customer", -3, "Marcus Hale's identity is verified.", [{ type: "edge", id: "r-tr-hale" }]),
  ],
  "lumen-trade": [
    reason("NOMINEE_DIRECTOR", "structure", 22, "Director Gregory Pell also directs 41 dormant companies, a common sign of a nominee.", [{ type: "edge", id: "r-lumen-pell" }]),
    reason("UNKNOWN_OWNER", "structure", 20, "The owners of Seaview Nominees Ltd are not disclosed.", [{ type: "edge", id: "r-lumen-seaview" }]),
    reason("HIGH_RISK_JURIS", "jurisdiction", 15, "Ownership passes through the Seychelles.", [{ type: "node", id: "p-seaview-nominees" }]),
    reason("FORMATION", "service", 8, "Company formation services are a higher-risk designated service.", []),
  ],
  "aurelian-shipping": [
    reason("SANCTIONS_REVIEW", "screening", 30, "Aurelian Maritime FZE closely matches an entry on a sanctions list (pending review).", [{ type: "hit", id: "h-aurelian" }]),
    reason("OFFSHORE_LAYER", "jurisdiction", 12, "The client is wholly owned through the United Arab Emirates.", [{ type: "edge", id: "r-aurelian-fze" }]),
    reason("REMOTE", "channel", 8, "The client was onboarded without meeting in person.", []),
    reason("CLIENT_FUNDS", "service", 10, "The matter involves holding client money.", []),
  ],
  "whitfield-julian": [
    reason("PEP", "customer", 35, "Julian Whitfield is a domestic politically exposed person (NSW Legislative Council).", [{ type: "hit", id: "h-whitfield" }]),
    reason("PROPERTY", "service", 12, "A residential property purchase above $3 million.", []),
    reason("SOW_DONE", "customer", -4, "Source of wealth has been evidenced.", []),
  ],
  "ironbark-ventures": [
    reason("NEW_OWNER", "structure", 18, "A new 40% owner, Cayman Crest Holdings Ltd, appeared last month.", [{ type: "edge", id: "r-ironbark-cayman" }]),
    reason("UNKNOWN_OWNER", "structure", 20, "The owners of Cayman Crest Holdings Ltd are not disclosed.", [{ type: "node", id: "p-cayman-crest" }]),
    reason("OFFSHORE_LAYER", "jurisdiction", 14, "40% is held through the Cayman Islands.", [{ type: "edge", id: "r-ironbark-cayman" }]),
    reason("ID_VERIFIED", "customer", -3, "Owen Pryce's identity is verified.", []),
  ],
};

function genericReasons(c: Client): RiskReason[] {
  const r: RiskReason[] = [];
  if (c.flags.includes("nominee")) r.push(reason("NOMINEE_DIRECTOR", "structure", 22, "A director in the structure holds many other appointments, a common sign of a nominee."));
  if (c.flags.includes("circular")) r.push(reason("CIRCULAR", "structure", 20, "Ownership loops back on itself through other companies."));
  if (c.flags.includes("offshore")) r.push(reason("OFFSHORE_LAYER", "jurisdiction", 14, "Ownership passes through a company outside Australia."));
  if (c.flags.includes("pep")) r.push(reason("PEP", "customer", 25, "A politically exposed person sits in the structure."));
  if (c.flags.includes("sanctions_review")) r.push(reason("SANCTIONS_REVIEW", "screening", 6, "A possible sanctions match is waiting for review; early signs point to a namesake."));
  if (c.kind === "trust") r.push(reason("TRUST", "structure", 12, "A trust sits at the top of the structure."));
  if (c.channel === "remote") r.push(reason("REMOTE", "channel", 8, "The client was onboarded without meeting in person."));
  if (c.services.includes("managing_client_funds")) r.push(reason("CLIENT_FUNDS", "service", 10, "The matter involves holding client money."));
  if (c.services.includes("other") && c.name.includes("Art")) r.push(reason("CASH_HEAVY", "service", 18, "Art dealing is a cash-heavy business."));
  if (c.jurisdiction !== "AU") r.push(reason("FOREIGN", "jurisdiction", 10, "The client is incorporated outside Australia."));
  if (c.name === "Southbank Holdings Pty Ltd") r.push(reason("UNKNOWN_OWNER", "structure", 35, "30% of the client is held by an undisclosed holder."), reason("PROPERTY", "service", 12, "A commercial property purchase."), reason("LAYERS", "structure", 8, "The holder's interest cannot be traced to a person."));
  if (c.name === "Kenji Sato") r.push(reason("NON_RESIDENT", "customer", 18, "The client lives outside Australia."));
  if (c.name === "Greenfield Estates Pty Ltd") r.push(reason("DUPLICATE", "customer", 20, "The owner may already be on file under another name."));
  r.push(reason("ID_VERIFIED", "customer", -5, "Identity is verified for everyone who owns or controls the client."));
  return r;
}

function harbourlineRisk(clients: Client[]): RiskAssessment[] {
  const out: RiskAssessment[] = [];
  for (const c of clients) {
    if (!c.rating) continue;
    const key = c.id.slice(2);
    let reasons = REASONS[key] ?? genericReasons(c);
    let score = Math.max(4, Math.min(96, reasons.reduce((a, r) => a + r.points, 0) + (c.rating === "high" ? 8 : c.rating === "medium" ? 12 : 6)));
    const band = (s: number): Rating => (s >= 60 ? "high" : s >= 30 ? "medium" : "low");
    if (band(score) !== c.rating) {
      const target = c.rating === "high" ? 64 + (key.length % 20) : c.rating === "medium" ? 38 + (key.length % 18) : 12 + (key.length % 14);
      reasons = [...reasons];
      score = target;
    }
    const disagree = ["tasman-ridge", "coralline", "ironbark-ventures"].includes(key);
    const challengerRating: Rating = disagree ? (c.rating === "high" ? "medium" : "high") : c.rating;
    const edd = c.rating === "high" || c.flags.includes("pep");
    out.push({
      id: `ra-${key}`,
      clientId: c.id,
      methodologyVersion: "KR-RM-1.0",
      score,
      rating: c.rating,
      reasons: reasons.sort((a, b) => b.points - a.points),
      challenger: {
        modelVersion: "risk-challenger 2.1",
        probabilityHigh: challengerRating === "high" ? 0.74 + (key.length % 9) / 100 : challengerRating === "medium" ? 0.31 : 0.06,
        rating: challengerRating,
        agreement: disagree ? "disagree" : "agree",
        reasons: [mr("structure_depth", "Number of layers", 0.18), mr("offshore_share", "Share held offshore", 0.12), mr("verified_ids", "Identity verified", -0.08)],
        ...(disagree ? { disagreementId: `dis-${key}` } : {}),
      },
      eddRequired: edd,
      eddTriggers: edd
        ? [
            c.flags.includes("pep")
              ? { code: "PEP", message: "A politically exposed person is in the structure.", measures: ["source_of_wealth", "senior_approval", "enhanced_monitoring"] }
              : { code: "HIGH_RATING", message: "The client is rated high.", measures: ["source_of_funds", "ubo_verification", "senior_approval"] },
          ]
        : [],
      inputsHash: `9f${key.length.toString(16)}a${(score * 977).toString(16)}`,
      assessedAt: stamp(key === "ironbark-ventures" ? 29 : 40 + (key.length % 30), 9, 12),
      override: null,
    });
  }
  return out;
}

const MEASURE_LABELS: Record<string, string> = {
  source_of_wealth: "Source of wealth",
  source_of_funds: "Source of funds for this matter",
  senior_approval: "Senior approval from a partner",
  ubo_verification: "Verify every beneficial owner's identity",
  purpose_of_relationship: "Purpose of the business relationship",
  adverse_media_check: "Adverse media check",
  enhanced_monitoring: "Enhanced ongoing monitoring",
};

function eddFor(c: Client, a: RiskAssessment | undefined): Edd {
  if (!a || !a.eddRequired) return { clientId: c.id, required: false, triggers: [], measures: [], signoffs: [], status: c.status === "onboarding" ? "in_progress" : "not_required" };
  const keys = [...new Set(a.eddTriggers.flatMap((t) => t.measures))];
  const key = c.id.slice(2);
  const done = key === "whitfield-julian" ? ["source_of_wealth", "enhanced_monitoring"] : key === "harbour-quay" ? ["ubo_verification"] : key === "southbank-holdings" ? [] : ["ubo_verification", "source_of_funds"];
  const measures = keys.map((k) => ({
    key: k as Edd["measures"][number]["key"],
    label: MEASURE_LABELS[k] ?? k,
    status: (done.includes(k) ? "done" : "todo") as "done" | "todo",
    documentIds: [],
    ...(done.includes(k) ? { completedBy: "Daniel Cho", completedAt: stamp(20), note: "Evidence on file." } : {}),
  }));
  const signoffs: Edd["signoffs"] =
    key === "whitfield-julian" ? [{ stage: "compliance", decision: "approve", note: "Source of wealth evidenced; PEP measures in place.", byName: "Daniel Cho", at: stamp(6) }] : [];
  const allDone = measures.filter((m) => m.key !== "senior_approval").every((m) => m.status === "done");
  const status: Edd["status"] = key === "whitfield-julian" ? "awaiting_senior" : allDone ? (["lumen-trade", "silverbirch", "tasman-ridge"].includes(key) ? "approved" : "awaiting_compliance") : "in_progress";
  if (status === "approved") {
    measures.forEach((m) => {
      m.status = "done";
      m.completedBy = "Daniel Cho";
      m.completedAt = stamp(90);
    });
    signoffs.push({ stage: "compliance", decision: "approve", note: "EDD complete.", byName: "Daniel Cho", at: stamp(88) }, { stage: "senior", decision: "approve", note: "Approved to act.", byName: "Margaret Ellis", at: stamp(87) });
  }
  return { clientId: c.id, required: true, triggers: a.eddTriggers, measures, signoffs, status };
}

function partyRecord(p: WParty) {
  return { id: p.id, kind: p.kind === "stack" ? ("company" as const) : p.kind, name: p.name, birthDate: p.birthDate, nationality: p.nationality, jurisdiction: p.jurisdiction, identifiers: p.identifiers, address: p.address, source: p.source, sourceRef: p.sourceRef };
}

function candidates(parties: Record<string, WParty>): MatchCandidate[] {
  const c = (id: string, l: string, r: string, prob: number, status: MatchCandidate["status"], reasons: MatchReason[], clientIds: string[], features: Record<string, number>, daysAgo: number): MatchCandidate => ({
    id,
    status,
    left: partyRecord(parties[l]!),
    right: partyRecord(parties[r]!),
    score: {
      probability: prob,
      band: prob >= 0.97 ? "auto_merge" : prob >= 0.4 ? "review" : "reject",
      fsWeight: Math.round((Math.log(prob / (1 - prob)) / Math.log(2)) * 100) / 100,
      fsProbability: Math.min(0.99, prob + 0.03),
      features,
      reasons,
      modelVersion: "er-matcher 1.4",
    },
    clientIds,
    createdAt: stamp(daysAgo, 11, 20),
    ...(status !== "pending" ? { decidedBy: "Kinroot (automatic)", decidedAt: stamp(daysAgo, 11, 21) } : {}),
  });
  const person = { name_jaro_winkler: 0.96, name_token_set: 0.8, name_phonetic_agree: 1, dob_exact: 1, dob_partial: 1, dob_transposed: 0, id_agree: -1, address_token_overlap: 0.62, postcode_agree: 1, nationality_agree: 1, jurisdiction_agree: 1, kind_agree: 1 };
  return [
    c("m-reyes", "p-jonathan-reyes", "p-jonathon-reyes", 0.87, "pending", [mr("dob_exact", "Same date of birth", 0.46, 1), mr("address_token_overlap", "Same street address", 0.38, 0.62), mr("name_phonetic_agree", "Names sound the same", 0.24, 1), mr("shared_company", "Both linked to Pyrmont Wharf Pty Ltd", 0.2, 1), mr("middle_name", "Middle name missing on one record", -0.1, 0)], ["c-bellmere", "c-harbour-quay"], person, 2),
    c("m-okafor", "p-ben-okafor", "p-benjamin-okafor", 0.81, "pending", [mr("dob_exact", "Same date of birth", 0.48, 1), mr("name_token_set", "Ben is a short form of Benjamin", 0.3, 0.9), mr("nationality_agree", "Same nationality", 0.08, 1), mr("address_token_overlap", "Different home addresses", -0.22, 0.1), mr("id_agree", "Only one record has an ID number", 0, -1)], ["c-greenfield-estates", "c-harbour-quay", "c-bellmere"], { ...person, address_token_overlap: 0.1 }, 4),
    c("m-pell", "p-gregory-pell", "p-greg-pell", 0.93, "pending", [mr("dob_exact", "Same date of birth", 0.44, 1), mr("address_token_overlap", "Same office address in Mahé", 0.36, 0.8), mr("name_token_set", "Greg is a short form of Gregory", 0.28, 0.9), mr("nationality_agree", "Same nationality", 0.06, 1)], ["c-silverbirch", "c-lumen-trade"], { ...person, address_token_overlap: 0.8 }, 6),
    c("m-calder", "p-ava-calder", "p-ava-m-calder", 0.76, "pending", [mr("dob_exact", "Same date of birth", 0.46, 1), mr("address_token_overlap", "Same street, written differently", 0.3, 0.7), mr("name_token_set", "Middle initial on one record only", 0.12, 0.85), mr("id_agree", "Only one record has an ID number", 0, -1)], ["c-marlowe-art", "c-harbour-quay"], person, 9),
    c("m-oconnor", "p-sean-oconnor", "p-sean-oconnor-2", 0.99, "auto_merged", [mr("name_jaro_winkler", "Names are almost identical", 0.5, 0.99), mr("dob_exact", "Same date of birth", 0.46, 1)], ["c-oconnor-sean"], person, 30),
    c("m-murray", "p-murray-chen", "p-murray-cheng", 0.18, "not_match", [mr("name_jaro_winkler", "Names are almost identical", 0.3, 0.95), mr("dob_exact", "Different dates of birth", -0.6, 0)], ["c-murray-chen"], { ...person, dob_exact: 0, dob_partial: 0 }, 32),
    c("m-nguyen", "p-linh-nguyen", "p-lin-nguyen", 0.22, "not_match", [mr("name_phonetic_agree", "Names sound the same", 0.28, 1), mr("dob_exact", "Different dates of birth", -0.58, 0)], ["c-nguyen-linh"], { ...person, dob_exact: 0 }, 40),
  ];
}

const LIST_ENTRIES: ListEntry[] = [
  { id: "SAMPLE-SAN-0007", listKind: "sanctions", name: "Aurelian Maritime FZCO", aliases: ["Aurelian Marine FZCO", "AMF Shipping"], countries: ["AE"], programs: ["Sample consolidated list · maritime"], source: "Sample sanctions list (fictional)" },
  { id: "SAMPLE-SAN-0012", listKind: "sanctions", name: "Aleksei Petrov", aliases: ["Alexei Petrov", "A. Petrov"], birthDate: "1971", countries: ["RU"], programs: ["Sample consolidated list"], source: "Sample sanctions list (fictional)" },
  { id: "SAMPLE-PEP-0003", listKind: "pep", name: "Julian Whitfield", aliases: ["Hon. Julian Whitfield MLC"], birthDate: "1961-07-09", countries: ["AU"], programs: ["NSW Legislative Council member"], source: "Sample PEP list (fictional)" },
  { id: "SAMPLE-PEP-0009", listKind: "pep", name: "Julian Whitfield-Hayes", aliases: [], birthDate: "1955", countries: ["GB"], programs: ["Local councillor"], source: "Sample PEP list (fictional)" },
];

function hits(): ScreeningHit[] {
  const e = (id: string) => LIST_ENTRIES.find((x) => x.id === id)!;
  return [
    { id: "h-aurelian", clientId: "c-aurelian-shipping", partyId: "p-aurelian-fze", partyName: "Aurelian Maritime FZE", entry: e("SAMPLE-SAN-0007"), score: 0.91, reasons: [mr("name_token_set", "Names differ only in the company suffix", 0.52, 0.94), mr("country", "Same country (United Arab Emirates)", 0.24, 1), mr("officer", "Shared director surname", 0.14, 1)], status: "pending", createdAt: stamp(3, 8, 4) },
    { id: "h-petrov", clientId: "c-petrov-alexei", partyId: "p-alexei-petrov", partyName: "Alexei Petrov", entry: e("SAMPLE-SAN-0012"), score: 0.72, reasons: [mr("name_phonetic_agree", "Names sound the same", 0.44, 1), mr("dob_partial", "Different birth year (1988 and 1971)", -0.36, 0), mr("nationality_agree", "Different nationality", -0.18, 0)], status: "pending", createdAt: stamp(5, 8, 4) },
    { id: "h-whitfield", clientId: "c-whitfield-julian", partyId: "p-julian-whitfield", partyName: "Hon. Julian Whitfield", entry: e("SAMPLE-PEP-0003"), score: 0.98, reasons: [mr("name_jaro_winkler", "Same name", 0.5, 1), mr("dob_exact", "Same date of birth", 0.46, 1)], status: "true_match", createdAt: stamp(60), reviewedBy: "Daniel Cho", reviewedAt: stamp(58), reviewReason: "Confirmed against the NSW Parliament members register; client acknowledges the role." },
    { id: "h-whitfield-ns", clientId: "c-whitfield-julian", partyId: "p-julian-whitfield", partyName: "Hon. Julian Whitfield", entry: e("SAMPLE-PEP-0009"), score: 0.61, reasons: [mr("name_token_set", "Similar names", 0.3, 0.8), mr("dob_partial", "Different birth year", -0.4, 0)], status: "false_positive", createdAt: stamp(60), reviewedBy: "Daniel Cho", reviewedAt: stamp(58), reviewReason: "Different person: UK councillor born 1955, different middle name." },
  ];
}

function alerts(): Alert[] {
  return [
    { id: "al-aurelian", clientId: "c-aurelian-shipping", clientName: "Aurelian Shipping Pty Ltd", kind: "list_update_hit", severity: "critical", title: "Sanctions list update: possible match", body: "A list update added Aurelian Maritime FZCO. Kinroot found Aurelian Maritime FZE, the client's 100% owner, as a close match.", evidence: [{ type: "hit", id: "h-aurelian" }, { type: "edge", id: "r-aurelian-fze" }], status: "open", createdAt: stamp(3, 8, 5) },
    { id: "al-harbour", clientId: "c-harbour-quay", clientName: "Harbour Quay Developments Pty Ltd", kind: "officer_change", severity: "warning", title: "New director at Kestrel Ventures Ltd", body: "Marisol Duarte replaced Ana Ruiz as director of Kestrel Ventures Ltd, the client's 100% owner. Ms Duarte holds 23 other directorships.", evidence: [{ type: "edge", id: "r-kestrel-duarte" }, { type: "edge", id: "r-kestrel-ruiz" }], status: "open", createdAt: stamp(63, 7, 50) },
    { id: "al-ironbark", clientId: "c-ironbark-ventures", clientName: "Ironbark Ventures Pty Ltd", kind: "ownership_change", severity: "warning", title: "New 40% owner in the Cayman Islands", body: "Cayman Crest Holdings Ltd now holds 40% of the client. Owen Pryce's holding fell from 100% to 60%.", evidence: [{ type: "edge", id: "r-ironbark-cayman" }, { type: "edge", id: "r-ironbark-pryce" }], status: "open", createdAt: stamp(28, 7, 50) },
    { id: "al-harrow", clientId: "c-harrow-mining", clientName: "Harrow Mining Services Pty Ltd", kind: "officer_change", severity: "info", title: "Director change at Harrow Mining Services", body: "Nadia Petrenko replaced Keith Barlow as director.", evidence: [{ type: "edge", id: "r-harrow-petrenko" }], status: "open", createdAt: stamp(40, 7, 50) },
    { id: "al-patel", clientId: "c-patel-riya", clientName: "Riya Patel", kind: "review_due", severity: "warning", title: "Periodic review overdue by 40 days", body: "The three-yearly review has not been completed.", evidence: [], status: "open", createdAt: stamp(40, 6, 0) },
    { id: "al-delacroix", clientId: "c-delacroix-trust", clientName: "Delacroix Unit Trust", kind: "review_due", severity: "warning", title: "Periodic review overdue by 12 days", body: "The two-yearly review has not been completed.", evidence: [], status: "open", createdAt: stamp(12, 6, 0) },
    { id: "al-greenfield", clientId: "c-greenfield-estates", clientName: "Greenfield Estates Pty Ltd", kind: "review_due", severity: "info", title: "Periodic review overdue by 7 days", body: "The two-yearly review has not been completed.", evidence: [], status: "open", createdAt: stamp(7, 6, 0) },
  ];
}

// FNV-1a 64-bit as hex: a stand-in for the API's SHA-256 seal chain (fixtures only).
export function seal(prev: string, body: string): string {
  let h1 = 0x811c9dc5,
    h2 = 0x01000193;
  const s = prev + "|" + body;
  for (let i = 0; i < s.length; i++) {
    h1 = Math.imul(h1 ^ s.charCodeAt(i), 16777619) >>> 0;
    h2 = Math.imul(h2 ^ s.charCodeAt(i), 2246822519) >>> 0;
  }
  return (h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0")).repeat(4);
}

function auditRows(clients: Client[]): AuditEntry[] {
  const actors = ["Daniel Cho", "Tom Nguyen", "Aisha Karim", "Margaret Ellis", "Olivia Grant"];
  const templates: [string, string, string | null][] = [
    ["client.created", "Opened a file for {c}", "client"],
    ["identity.verified", "Verified identity for a party of {c}", "client"],
    ["screening.run", "Screened {c} against sanctions and PEP lists", "client"],
    ["risk.assessed", "Rated {c} with risk method KR-RM-1.0", "client"],
    ["document.uploaded", "Uploaded a company extract for {c}", "client"],
    ["client.viewed", "Opened the dossier for {c}", "client"],
    ["auth.login", "Signed in", null],
  ];
  const rows: Omit<AuditEntry, "hash" | "prevHash">[] = [];
  const active = clients.filter((c) => c.status !== "onboarding");
  for (let i = 0; i < 168; i++) {
    const t = templates[(i * 5 + 3) % templates.length]!;
    const c = active[(i * 7) % active.length]!;
    const daysBack = Math.floor((168 - i) * 1.6);
    rows.push({ id: i + 1, action: t[0], label: t[1].replace("{c}", c.name), actorName: actors[(i * 3) % actors.length]!, actorType: "user", resourceType: t[2], resourceId: t[2] ? c.id : null, metadata: {}, ip: "203.0.113." + ((i % 40) + 10), createdAt: stamp(daysBack, 8 + (i % 9), (i * 13) % 60) });
  }
  const tail: [number, string, string, string, string | null, string | null, Record<string, unknown>][] = [
    [6, "Daniel Cho", "signoff.approved", "Signed off the PEP measures for Hon. Julian Whitfield", "client", "c-whitfield-julian", {}],
    [5, "Daniel Cho", "case.opened", "Opened case SMR-2025-003", "case", "case-aurelian", { restricted: true }],
    [4, "Tom Nguyen", "concern.raised", "Raised an internal concern", "concern", "con-1", {}],
    [3, "System", "alert.raised", "Sanctions list update: possible match for Aurelian Shipping Pty Ltd", "client", "c-aurelian-shipping", {}],
    [2, "Daniel Cho", "case.updated", "Updated the draft report for case SMR-2025-003", "case", "case-aurelian", { restricted: true }],
    [1, "Aisha Karim", "document.requested", "Requested Cayman Crest's register of members from Ironbark Ventures", "client", "c-ironbark-ventures", {}],
    [0, "Daniel Cho", "resolution.kept_apart", "Kept Murray Chen and Murray Cheng apart", "party", "p-murray-chen", {}],
  ];
  tail.forEach(([d, who, action, label, rt, rid, meta], k) =>
    rows.push({ id: rows.length + 1, action, label, actorName: who, actorType: who === "System" ? "system" : "user", resourceType: rt, resourceId: rid, metadata: meta, ip: "203.0.113.20", createdAt: stamp(d, 9 + k, 12 + k * 4) }),
  );
  rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  let prev = "0".repeat(64);
  return rows.map((r, i) => {
    const hash = seal(prev, `${r.action}|${r.label}|${r.createdAt}`);
    const out = { ...r, id: i + 1, prevHash: prev, hash };
    prev = hash;
    return out;
  });
}

function documents(clients: Client[], g: WorldGraph): Record<string, DocumentRec[]> {
  const out: Record<string, DocumentRec[]> = {};
  for (const c of clients) {
    const docs: DocumentRec[] = [];
    const ids = new Set<string>([c.partyId]);
    g.rels.filter((r) => r.toPartyId === c.partyId).forEach((r) => ids.add(r.fromPartyId));
    if (c.id === "c-harbour-quay") ["p-ava-calder", "p-ben-okafor", "p-kestrel-ventures", "p-calder-trust", "p-bellmere"].forEach((x) => ids.add(x));
    let i = 0;
    for (const id of ids) {
      const p = g.parties[id];
      if (!p || p.kind === "stack" || p.kind === "address") continue;
      const docType = p.kind === "person" ? (i % 2 ? "drivers_licence" : "passport") : p.kind === "trust" ? "trust_deed" : "company_extract";
      const fileName = p.kind === "person" ? `${p.name.split(" ").pop()?.toLowerCase()}-${docType}.pdf` : `${p.name.toLowerCase().replace(/[^a-z]+/g, "-").replace(/-$/, "")}-${docType === "trust_deed" ? "trust-deed" : "extract"}.pdf`;
      docs.push({ id: `d-${c.id}-${i}`, partyId: id, docType, fileName, sizeBytes: 180_000 + i * 41_000, sha256: seal("doc", fileName).slice(0, 64), uploadedBy: c.assignedTo?.fullName ?? "Daniel Cho", uploadedAt: stamp(200 - i * 3), retainUntil: daysFromToday(7 * 365 + 200) });
      i++;
    }
    if (c.id === "c-lim-family") docs.splice(2);
    out[c.id] = docs;
  }
  return out;
}

function buildHarbourline(): World {
  const { g, clients, addressLinks } = harbourlineClients();
  const graph: WorldGraph = { parties: g.parties, rels: g.rels, clients, addressLinks };
  const assessments = harbourlineRisk(clients);
  const edd: Record<string, Edd> = {};
  clients.forEach((c) => (edd[c.id] = eddFor(c, assessments.find((a) => a.clientId === c.id))));
  const org = ORGS[0]!;
  const caseOpened = stamp(3, 14, 5);
  const world: World = {
    ...graph,
    org,
    settings: {
      retention: { years: 7, trigger: "relationship_end", legalHoldClientIds: [] },
      reviews: { highMonths: 12, mediumMonths: 24, lowMonths: 36 },
      screening: { autoRescreenOnListUpdate: true, fuzzyThreshold: 0.82 },
      ubo: { thresholdPct: 25 },
      resolution: { autoMergeEnabled: true },
      notifications: { criticalAlerts: "immediate", reviewReminderDays: 30, signoffRequests: true, weeklyDigest: true, digestDay: "monday" },
    },
    members: [
      { userId: "u-olivia", orgId: org.id, role: "owner", joinedAt: stamp(420) },
      { userId: "u-daniel", orgId: org.id, role: "compliance_officer", joinedAt: stamp(420) },
      { userId: "u-margaret", orgId: org.id, role: "partner", joinedAt: stamp(410) },
      { userId: "u-tom", orgId: org.id, role: "fee_earner", joinedAt: stamp(400) },
      { userId: "u-aisha", orgId: org.id, role: "fee_earner", joinedAt: stamp(380) },
      { userId: "u-ruth", orgId: org.id, role: "auditor", joinedAt: stamp(200) },
    ],
    invitations: [{ id: "inv-1", token: "demo-invite-ferreira", email: "m.ferreira@harbourline.example", role: "auditor", expiresAt: stamp(-6), acceptedAt: null, createdAt: stamp(1) }],
    candidates: candidates(g.parties),
    listEntries: LIST_ENTRIES,
    hits: hits(),
    assessments,
    edd,
    alerts: alerts(),
    cases: [
      {
        id: "case-aurelian",
        clientId: "c-aurelian-shipping",
        clientName: "Aurelian Shipping Pty Ltd",
        title: "SMR-2025-003 · Aurelian Shipping Pty Ltd",
        status: "open",
        grounds: "Funds for the property settlement were routed through Aurelian Maritime FZE, which closely matches a sanctioned entity. The client asked twice to bring settlement forward and to pay the deposit from a third-party account.",
        accessLevel: "full",
        redactedFields: [],
        openedBy: "Daniel Cho",
        openedAt: caseOpened,
        deadlineOn: "",
        smrStatus: "draft",
        access: [
          { userId: "u-daniel", fullName: "Daniel Cho", level: "full" },
          { userId: "u-margaret", fullName: "Margaret Ellis", level: "summary" },
        ],
      },
      {
        id: "case-older",
        clientId: "c-coastal-conveyancing",
        clientName: "Coastal Conveyancing Co",
        title: "SMR-2025-001 · Coastal Conveyancing Co",
        status: "reported",
        grounds: "Trust account receipts split into amounts just under the reporting threshold over nine days.",
        accessLevel: "full",
        redactedFields: [],
        openedBy: "Daniel Cho",
        openedAt: stamp(190, 10, 0),
        deadlineOn: daysFromToday(-186),
        smrStatus: "submitted",
        access: [{ userId: "u-daniel", fullName: "Daniel Cho", level: "full" }],
      },
    ],
    smr: {},
    caseTimeline: {
      "case-aurelian": [
        { at: stamp(4, 16, 10), actorName: "Tom Nguyen", action: "concern.raised", label: "Internal concern received" },
        { at: caseOpened, actorName: "Daniel Cho", action: "case.opened", label: "Case opened; suspicion formed" },
        { at: stamp(2, 11, 30), actorName: "Daniel Cho", action: "smr.drafted", label: "Draft report updated" },
      ],
    },
    audit: auditRows(clients),
    training: [
      { id: "t1", userId: "u-daniel", fullName: "Daniel Cho", course: "AML/CTF compliance officer refresher", completedOn: ago(80), dueOn: ahead(285), status: "current" },
      { id: "t2", userId: "u-margaret", fullName: "Margaret Ellis", course: "Tranche 2 for partners", completedOn: ago(120), dueOn: ahead(245), status: "current" },
      { id: "t3", userId: "u-tom", fullName: "Tom Nguyen", course: "Customer due diligence essentials", completedOn: ago(340), dueOn: ahead(25), status: "due_soon" },
      { id: "t4", userId: "u-aisha", fullName: "Aisha Karim", course: "Customer due diligence essentials", completedOn: ago(390), dueOn: ago(25), status: "overdue" },
      { id: "t5", userId: "u-olivia", fullName: "Olivia Grant", course: "AML/CTF awareness", completedOn: ago(60), dueOn: ahead(305), status: "current" },
      { id: "t6", userId: "u-ruth", fullName: "Ruth Adeyemi", course: "AML/CTF awareness", completedOn: ago(150), dueOn: ahead(215), status: "current" },
    ],
    methodologies: [
      {
        id: "meth-1-1",
        version: "KR-RM-1.1",
        status: "draft",
        bands: { medium: 30, high: 60 },
        rules: [
          { code: "UNKNOWN_OWNER", factor: "structure", description: "Part of the structure is held by undisclosed owners", points: 22, condition: "unexplained share ≥ 10%" },
          { code: "NOMINEE_DIRECTOR", factor: "structure", description: "A director holds 20 or more other appointments", points: 18, condition: "appointments ≥ 20" },
        ],
      },
      {
        id: "meth-1-0",
        version: "KR-RM-1.0",
        status: "published",
        publishedAt: stamp(300),
        publishedBy: "Daniel Cho",
        bands: { medium: 30, high: 60 },
        rules: [
          { code: "PEP", factor: "customer", description: "A politically exposed person is in the structure", points: 35, condition: "PEP match confirmed" },
          { code: "SANCTIONS_REVIEW", factor: "screening", description: "A possible sanctions match is open", points: 30, condition: "pending hit, score ≥ 0.85" },
          { code: "CIRCULAR", factor: "structure", description: "Ownership loops back on itself", points: 25, condition: "any ownership cycle" },
          { code: "NOMINEE_DIRECTOR", factor: "structure", description: "A director holds many other appointments", points: 22, condition: "appointments ≥ 20" },
          { code: "UNKNOWN_OWNER", factor: "structure", description: "Part of the structure is held by undisclosed owners", points: 20, condition: "unexplained share > 0" },
          { code: "OFFSHORE_LAYER", factor: "jurisdiction", description: "Ownership passes through a company outside Australia", points: 14, condition: "any foreign entity on a path" },
          { code: "HIGH_RISK_JURIS", factor: "jurisdiction", description: "A high-risk jurisdiction is on a path", points: 15, condition: "FATF list or secrecy index" },
          { code: "LAYERS", factor: "structure", description: "Three or more layers before a person", points: 12, condition: "depth ≥ 3" },
          { code: "CLIENT_FUNDS", factor: "service", description: "The firm holds client money", points: 10, condition: "service = managing client funds" },
          { code: "REMOTE", factor: "channel", description: "Onboarded without meeting in person", points: 8, condition: "channel = remote" },
          { code: "ID_VERIFIED", factor: "customer", description: "Identity verified for everyone who owns or controls", points: -5, condition: "all identity checks verified" },
        ],
      },
    ],
    documents: documents(clients, graph),
    consents: [],
    insights: [
      { id: "i1", tone: "risk", title: "3 clients share a director who holds 41 other appointments", body: "Lumen Trade, Silverbirch Imports and Coralline Logistics all have Gregory Pell as director.", href: "/board?lens=shared" },
      { id: "i2", tone: "progress", title: "Onboarding time fell from 6 to 3 days", body: "Clients filling in their own details through the client link finish twice as fast.", metric: { value: 3, unit: "days", trend: "down" } },
      { id: "i3", tone: "info", title: "Reviews overdue: 3", body: "Riya Patel, Delacroix Unit Trust and Greenfield Estates.", href: "/alerts" },
      { id: "i4", tone: "info", title: "The second opinion agrees on 90% of clients", body: "3 disagreements are open for the compliance officer.", metric: { value: 90, unit: "%", trend: "flat" } },
    ],
    reviewsDone: {},
  };
  const aurelian = world.cases[0]!;
  // SMR deadline: 3 business days from forming the suspicion (computed at runtime).
  aurelian.deadlineOn = addBusinessDaysIso(aurelian.openedAt.slice(0, 10), 3);
  world.smr["case-aurelian"] = {
    caseId: "case-aurelian",
    version: 3,
    regime: "AUSTRAC_SMR",
    suspicionGrounds: aurelian.grounds!,
    subjects: [
      { partyId: "p-aurelian-shipping", name: "Aurelian Shipping Pty Ltd", role: "Client" },
      { partyId: "p-aurelian-fze", name: "Aurelian Maritime FZE", role: "100% owner" },
      { partyId: "p-yusuf-karimov", name: "Yusuf Karimov", role: "Director" },
    ],
    transactions: [
      { date: ago(9), amount: 250000, currency: "AUD", description: "Deposit from a third-party account (Dubai)" },
      { date: ago(5), amount: 1840000, currency: "AUD", description: "Settlement funds requested early" },
    ],
    narrative:
      "The firm acts for Aurelian Shipping Pty Ltd on a commercial property purchase. Its sole owner, Aurelian Maritime FZE, closely matches a sanctioned entity on the consolidated list. The deposit came from an account not in the client's name, and the client twice asked to bring settlement forward.",
    attachments: ["E-01 Aurelian Maritime FZE → Aurelian Shipping Pty Ltd", "Screening match h-aurelian", "Deposit receipt"],
    updatedBy: "Daniel Cho",
    updatedAt: stamp(2, 11, 30),
  };
  // Structure summary counts for every client.
  return world;
}

function addBusinessDaysIso(s: string, n: number): string {
  const [y, m, d] = s.split("-").map(Number) as [number, number, number];
  const dt = new Date(y, m - 1, d);
  let left = n;
  while (left > 0) {
    dt.setDate(dt.getDate() + 1);
    if (dt.getDay() !== 0 && dt.getDay() !== 6) left--;
  }
  return isoDate(dt);
}

function buildNorthgate(): World {
  const g = makeBuilders();
  g.party("p-ng-ashby", "company", "Ashby & Rowe Ltd", { jurisdiction: "GB", identifiers: { ukCompanyNumber: "09441827" } });
  g.party("p-ng-hal", "person", "Harriet Ashby", { birthDate: "1974-05-05", nationality: "GB" });
  g.party("p-ng-rowe", "person", "Simon Rowe", { birthDate: "1971-09-19", nationality: "GB" });
  g.own("p-ng-hal", "p-ng-ashby", 60, { source: "Companies House PSC" });
  g.own("p-ng-rowe", "p-ng-ashby", 40, { source: "Companies House PSC" });
  g.party("p-ng-mills", "person", "Tobias Mills", { birthDate: "1988-02-11", nationality: "GB" });
  const base = (key: string, partyId: string, kind: Client["kind"], rating: Rating): Client => ({
    id: `c-${key}`,
    kind,
    name: g.parties[partyId]!.name,
    status: "active",
    jurisdiction: "GB",
    partyId,
    services: ["tax_advice"],
    channel: "face_to_face",
    matterReference: null,
    assignedTo: { id: "u-priya", fullName: "Priya Raman" },
    rating,
    ratingSource: "rules",
    eddRequired: false,
    nextReviewOn: ahead(300),
    lastReviewedOn: ago(60),
    onboardedOn: ago(60),
    structure: { parties: 1, layers: 0, ubos: 0 },
    flags: [],
    createdAt: stamp(60),
    updatedAt: stamp(5),
  });
  const clients = [base("ashby-rowe", "p-ng-ashby", "company", "low"), base("tobias-mills", "p-ng-mills", "individual", "low")];
  const graph: WorldGraph = { parties: g.parties, rels: g.rels, clients, addressLinks: [] };
  const w = buildHarbourline();
  return {
    ...w,
    ...graph,
    org: ORGS[1]!,
    settings: { ...w.settings, retention: { ...w.settings.retention, years: 5 } },
    members: [{ userId: "u-priya", orgId: "org-northgate", role: "compliance_officer", joinedAt: stamp(300) }],
    invitations: [],
    candidates: [],
    hits: [],
    assessments: harbourlineRisk(clients),
    edd: Object.fromEntries(clients.map((c) => [c.id, eddFor(c, undefined)])),
    alerts: [],
    cases: [],
    smr: {},
    caseTimeline: {},
    audit: auditRows(clients).slice(0, 20),
    training: [],
    documents: documents(clients, graph),
    insights: [],
  };
}

export function memberView(w: World, m: Membership): Member {
  const u = userById(m.userId);
  const t = w.training.find((x) => x.userId === m.userId);
  return { id: `mem-${m.userId}`, userId: m.userId, fullName: u.fullName, email: u.email, role: m.role, roleLabel: ROLE_LABELS[m.role], status: "active", joinedAt: m.joinedAt, trainingDueOn: t?.dueOn ?? null };
}
