import type { Address, Client, Rating } from "../api/types";

export interface StatusLook {
  cls: "clear" | "review" | "high" | "neutral" | "restricted" | "unknown";
  glyph: string;
  word: string;
}
/** Rating language: glyph + word + colour, never colour alone (DESIGN.md §9). */
export function ratingLook(r: Rating | null | undefined): StatusLook {
  if (r === "high") return { cls: "high", glyph: "▲", word: "High" };
  if (r === "medium") return { cls: "review", glyph: "◆", word: "Review" };
  if (r === "low") return { cls: "clear", glyph: "●", word: "Clear" };
  return { cls: "neutral", glyph: "○", word: "Not rated" };
}
export const KIND_LABEL: Record<Client["kind"], string> = { individual: "Individual", company: "Company", trust: "Trust", partnership: "Partnership" };
export const SERVICE_LABEL: Record<string, string> = {
  conveyancing: "Conveyancing",
  company_formation: "Company formation",
  trust_formation: "Trust formation",
  property_transaction: "Property transaction",
  managing_client_funds: "Holding client money",
  tax_advice: "Tax advice",
  audit: "Audit",
  real_estate_sale: "Real estate sale",
  other: "Other",
};
export const COUNTRY: Record<string, string> = { AU: "Australia", GB: "United Kingdom", VG: "British Virgin Islands", NZ: "New Zealand", SC: "Seychelles", AE: "United Arab Emirates", KY: "Cayman Islands", JP: "Japan", FR: "France", ES: "Spain", PA: "Panama", UA: "Ukraine", IE: "Ireland", RU: "Russia" };
export function likelihood(p: number): string {
  return `${Math.round(p * 100)} in 100`;
}
export function plural(n: number, one: string, many = one + "s"): string {
  return `${n} ${n === 1 ? one : many}`;
}
export function bytes(n: number): string {
  return n > 1_000_000 ? `${(n / 1_000_000).toFixed(1)} MB` : `${Math.round(n / 1000)} KB`;
}
export function addressText(a: Address | string | null | undefined): string | null {
  if (!a) return null;
  if (typeof a === "string") return a;
  const line = [a.line1, [a.locality, a.state, a.postcode].filter(Boolean).join(" "), a.country && a.country !== "AU" ? a.country : ""].filter(Boolean).join(", ");
  return line || null;
}

/** A screening list's source in plain words ("bundled-sample@2025.10" → "Sample list · fictional entries"). */
export function listSourceLabel(source: string | null | undefined): string {
  const s = (source ?? "").toLowerCase();
  if (!s) return "Screening list";
  if (s.startsWith("bundled") || s.includes("sample")) return "Sample list · fictional entries";
  if (s.includes("opensanctions")) return "OpenSanctions";
  return source!.replace(/[@_-]+/g, " ").trim();
}
