// Two records side by side: one row per field, a mark in the middle (= same, ≈ close, ≠ differs, — can't compare)
// with what it means on hover. Used by screening matches and possible duplicates.
import type { ReactNode } from "react";

export interface CompareRow {
  field: string;
  a: string | null | undefined;
  b: string | null | undefined;
  mark: string;
  word: string;
}

const TONE: Record<string, string> = { "=": "same", "≈": "close", "≠": "differs", "—": "none" };

const norm = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
/** The mark says what the values show: never "same" when a side is missing or the words differ. */
export function honestMark(r: CompareRow): CompareRow {
  if (!r.a || !r.b) return r.mark === "≠" ? r : { ...r, mark: "—", word: "Can’t compare" };
  if (r.mark === "=" && norm(r.a) !== norm(r.b)) return { ...r, mark: "≈", word: r.word || "Close" };
  return r;
}

export function Compare({ a, b, score, scoreWord, rows, missing = "Not provided", extra }: { a: ReactNode; b: ReactNode; score: number; scoreWord: string; rows: CompareRow[]; missing?: string; extra?: ReactNode }) {
  return (
    <div className="compare card">
      <div className="cmp-head">
        <div className="cmp-side">{a}</div>
        <div className="cmp-score" aria-label={`${score} in 100 ${scoreWord}`}>
          <b>{score}</b>
          <small>in 100 {scoreWord}</small>
        </div>
        <div className="cmp-side right">{b}</div>
      </div>
      {extra}
      <table className="cmp-rows" aria-label="Field by field">
        <thead className="sr-only">
          <tr>
            <th scope="col">First record</th>
            <th scope="col">Field</th>
            <th scope="col">Second record</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(honestMark).map((r) => (
            <tr key={r.field} className={TONE[r.mark] ?? "none"}>
              <td className={r.a ? undefined : "muted"}>{r.a || missing}</td>
              <th scope="row" title={r.word}>
                <span className="cmp-field">{r.field}</span>
                <span className="cmp-mark" aria-hidden>
                  {r.mark}
                </span>
                <span className="sr-only">{r.word}</span>
              </th>
              <td className={r.b ? "right" : "right muted"}>{r.b || missing}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
