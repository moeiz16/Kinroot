// A single file on the board; the firm's constellation sits behind it, blurred and dimmed.
import type { ReactNode } from "react";
import { Link } from "react-router";
import { seeded } from "../../graph/layout";
import { Logo } from "../../shell/chrome";
import "./auth.css";

function Backdrop() {
  const rnd = seeded(20250901);
  const pins = Array.from({ length: 46 }, (_, i) => ({ x: rnd() * 1600, y: rnd() * 1000, k: i % 4, r: rnd() }));
  return (
    <svg className="auth-backdrop" viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <g stroke="var(--edge-faint)" strokeWidth="1.2">
        {pins.slice(0, 30).map((p, i) => {
          const q = pins[(i * 7 + 3) % pins.length]!;
          return Math.hypot(p.x - q.x, p.y - q.y) < 420 ? <line key={i} x1={p.x} y1={p.y} x2={q.x} y2={q.y} /> : null;
        })}
      </g>
      {pins.map((p, i) =>
        p.k === 0 ? (
          <circle key={i} cx={p.x} cy={p.y} r="13" fill="var(--paper)" stroke="var(--ink)" strokeWidth="1.5" />
        ) : (
          <rect key={i} x={p.x - 13} y={p.y - 13} width="26" height="26" rx="2" fill="var(--paper)" stroke={p.r > 0.85 ? "var(--high)" : "var(--ink)"} strokeWidth="1.5" />
        ),
      )}
    </svg>
  );
}

export function AuthCard({ tab, title, children, foot }: { tab: string; title: string; children: ReactNode; foot?: ReactNode }) {
  return (
    <div className="auth board">
      <Backdrop />
      <header className="auth-top">
        <Link to="/" className="auth-brand" aria-label="Kinroot home">
          <Logo />
          <span>Kinroot</span>
        </Link>
      </header>
      <main className="auth-main">
        <div className="auth-card">
          <div className="folder-tabs auth-tabs" aria-hidden="true">
            <span className="folder-tab" data-state="active">
              {tab}
            </span>
          </div>
          <div className="auth-paper">
            <div className="auth-ref">Kinroot · client due diligence and beneficial ownership</div>
            <h1>{title}</h1>
            {children}
          </div>
          {foot && <div className="auth-foot">{foot}</div>}
        </div>
      </main>
    </div>
  );
}
