// Sign-in, sign-up and invitations, form skeleton: a poster title in capitals, the form laid across the page as one
// strip of fields, and a drawn structure chart behind (a client at the foot, its owners above, one traced in moss).
import type { ReactNode } from "react";
import { Link } from "react-router";
import { Mark } from "../../shell/chart";
import "./auth.css";

function StructureArt() {
  // owners above, the client at the foot; elbow lines; one trace climbing to the owner
  const box = (x: number, y: number, w = 150, h = 46, fill = "var(--surface)") => <rect x={x - w / 2} y={y - h / 2} width={w} height={h} fill={fill} stroke="var(--ink)" strokeWidth="1.6" />;
  const oval = (x: number, y: number) => <ellipse cx={x} cy={y} rx={78} ry={25} fill="var(--surface)" stroke="var(--ink)" strokeWidth="1.6" />;
  const person = (x: number, y: number, fill = "var(--surface)") => <circle cx={x} cy={y} r={20} fill={fill} stroke="var(--ink)" strokeWidth="1.6" />;
  const elbow = (x1: number, y1: number, x2: number, y2: number, dash?: string) => (
    <path d={`M${x1} ${y1} V${y2 - 26} H${x2} V${y2}`} fill="none" stroke="var(--ink)" strokeWidth="1.5" strokeDasharray={dash} />
  );
  return (
    <svg className="auth-art" viewBox="0 0 900 640" aria-hidden="true">
      <g className="art-rules" stroke="var(--rule)" strokeDasharray="1 6" strokeLinecap="round">
        {[110, 250, 390, 530].map((y) => (
          <line key={y} x1="0" x2="900" y1={y} y2={y} />
        ))}
      </g>
      {elbow(250, 130, 450, 367)}
      {elbow(250, 130, 250, 227)}
      {elbow(250, 273, 450, 507)}
      {elbow(650, 273, 450, 507)}
      {elbow(650, 410, 450, 507, "6 4")}
      {elbow(820, 410, 650, 250, "1 4")}
      <path className="art-trace" d="M450 507 V481 H250 V273 V250 V227 V130" fill="none" stroke="var(--moss)" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
      {person(250, 110, "var(--moss)")}
      {box(250, 250)}
      {oval(450, 390)}
      {box(650, 250)}
      {person(650, 390)}
      {box(820, 390, 110, 40)}
      {box(450, 530, 190, 54, "var(--moss)")}
      <rect x="335" y="563" width="230" height="5" fill="var(--ink)" />
    </svg>
  );
}

export function AuthCard({ tab, title, children, foot }: { tab: string; title: string; children: ReactNode; foot?: ReactNode }) {
  return (
    <div className="auth">
      <StructureArt />
      <header className="auth-top">
        <Link to="/" className="wordmark" aria-label="Kinroot home">
          <Mark />
          <span className="wm">Kinroot</span>
        </Link>
        <span className="auth-tab">{tab}</span>
      </header>
      <main className="auth-main">
        <div className="auth-ref">Client due diligence and beneficial ownership</div>
        <h1 className="auth-title">
          <span className="set">{title}</span>
        </h1>
        <div className="auth-body">{children}</div>
        {foot && <div className="auth-foot">{foot}</div>}
      </main>
    </div>
  );
}
