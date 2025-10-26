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

export function Compare({ a, b, score, scoreWord, rows, missingA = "Not on file", missingB = "Not listed", extra }: { a: ReactNode; b: ReactNode; score: number; scoreWord: string; rows: CompareRow[]; missingA?: string; missingB?: string; extra?: ReactNode }) {
  return (
    <div className="compare card">
      <div className="cmp-head">
        <div className="cmp-side">{a}</div>
        <div className="cmp-score" aria-label={`${score} in 100 ${scoreWord}`}>
          <b>{score}</b>
          <small>in 100</small>
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
          {rows.map((r) => (
            <tr key={r.field} className={TONE[r.mark] ?? "none"}>
              <td className={r.a ? undefined : "muted"}>{r.a || missingA}</td>
              <th scope="row" title={r.word}>
                <span className="cmp-field">{r.field}</span>
                <span className="cmp-mark" aria-hidden>
                  {r.mark}
                </span>
                <span className="sr-only">{r.word}</span>
              </th>
              <td className={r.b ? "right" : "right muted"}>{r.b || missingB}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
