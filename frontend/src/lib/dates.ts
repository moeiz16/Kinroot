// Date helpers. Everything time-sensitive is computed from "today" at runtime (DESIGN.md §13).
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY = 86_400_000;

export function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
export function today(now: Date = new Date()): string {
  return isoDate(now);
}
export function parseDate(s: string): Date {
  // YYYY-MM-DD → local midnight; full timestamps parse natively.
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split("-").map(Number) as [number, number, number];
    return new Date(y, m - 1, d);
  }
  return new Date(s);
}
export function addDays(s: string, n: number): string {
  const d = parseDate(s);
  d.setDate(d.getDate() + n);
  return isoDate(d);
}
export function daysFromToday(n: number, now: Date = new Date()): string {
  return addDays(isoDate(now), n);
}
export function daysBetween(a: string, b: string): number {
  return Math.round((parseDate(b).getTime() - parseDate(a).getTime()) / DAY);
}
/** "10 Oct 2025" */
export function fmtDate(s: string | null | undefined, opts: { year?: boolean } = {}): string {
  if (!s) return "—";
  const d = parseDate(s);
  const base = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return opts.year === false ? base : `${base} ${d.getFullYear()}`;
}
/** "10 Oct 10:42" */
export function fmtDateTime(s: string): string {
  const d = new Date(s);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
export function relativeDays(s: string, now: Date = new Date()): string {
  const n = daysBetween(isoDate(now), s.slice(0, 10));
  if (n === 0) return "today";
  if (n === 1) return "tomorrow";
  if (n === -1) return "yesterday";
  return n > 0 ? `in ${n} days` : `${-n} days ago`;
}

/** When something is due, in words: "overdue", "today", "in 12 days", "in 5 weeks", "in 10 months". */
export function dueIn(s: string | null | undefined, now: Date = new Date()): string {
  if (!s) return "—";
  const n = daysBetween(isoDate(now), s.slice(0, 10));
  if (n < 0) return "overdue";
  if (n === 0) return "today";
  if (n === 1) return "tomorrow";
  if (n <= 31) return `in ${n} days`;
  if (n <= 91) return `in ${Math.round(n / 7)} weeks`;
  const m = Math.round(n / 30.4);
  return m >= 12 ? `in ${Math.round(m / 12)} year${m >= 18 ? "s" : ""}` : `in ${m} months`;
}

export const TRANCHE2_COMMENCEMENT = "2026-07-01";
/** Runtime wording for Australia's Tranche 2 commencement (never hard-coded as past). */
export function tranche2Line(now: Date = new Date()): string {
  const n = daysBetween(isoDate(now), TRANCHE2_COMMENCEMENT);
  if (n > 1) return `Tranche 2 obligations start in ${n} days.`;
  if (n === 1) return "Tranche 2 obligations start tomorrow.";
  return "Tranche 2 obligations in force since 1 July 2026.";
}

/** Add n business days (Mon–Fri) to an ISO date. Used for the SMR deadline chip. */
export function addBusinessDays(s: string, n: number): string {
  const d = parseDate(s);
  let left = n;
  while (left > 0) {
    d.setDate(d.getDate() + 1);
    const wd = d.getDay();
    if (wd !== 0 && wd !== 6) left--;
  }
  return isoDate(d);
}
export function businessDaysUntil(target: string, now: Date = new Date()): number {
  const start = parseDate(isoDate(now));
  const end = parseDate(target);
  if (end <= start) return -Math.max(0, Math.round((start.getTime() - end.getTime()) / DAY));
  let n = 0;
  const d = new Date(start);
  while (d < end) {
    d.setDate(d.getDate() + 1);
    const wd = d.getDay();
    if (wd !== 0 && wd !== 6) n++;
  }
  return n;
}
