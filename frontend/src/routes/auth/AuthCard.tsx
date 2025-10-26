// Sign-in, set-up and invitations: one centred card on the page ground, the mark above it, one title.
import type { ReactNode } from "react";
import { Link } from "react-router";
import { Mark } from "../../shell/chart";
import "./auth.css";

export function AuthCard({ title, children, foot }: { tab?: string; title: string; children: ReactNode; foot?: ReactNode }) {
  return (
    <div className="auth">
      <Link to="/" className="wordmark auth-mark" aria-label="Kinroot home">
        <Mark size={28} />
        <span className="wm">Kinroot</span>
      </Link>
      <main className="auth-card">
        <h1 className="auth-title">{title}</h1>
        <div className="auth-body">{children}</div>
      </main>
      {foot && <div className="auth-foot">{foot}</div>}
    </div>
  );
}
