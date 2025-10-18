import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { errorMessage } from "../../api/client";
import { DEMO_PASSWORD, DEMO_PEOPLE, useAuth } from "../../lib/auth";
import { AuthCard } from "./AuthCard";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export default function SignIn() {
  const { signIn } = useAuth();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const next = params.get("next") && params.get("next")!.startsWith("/") ? params.get("next")! : "/board";

  const go = async (e: string, p: string) => {
    setBusy(true);
    setError(null);
    try {
      await signIn(e, p);
      nav(next, { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard
      tab="Sign in"
      title="Sign in to your firm’s files"
      foot={
        <>
          <Button variant="link" onClick={() => go(DEMO_PEOPLE[0]!.email, DEMO_PASSWORD)} disabled={busy}>
            Open Harbourline’s files →
          </Button>
          <small>Sample firm · sample data. Or open the files as:</small>
          <div className="demo-roles">
            {DEMO_PEOPLE.map((p) => (
              <Button key={p.email} size="sm" onClick={() => go(p.email, DEMO_PASSWORD)} disabled={busy}>
                {p.role} · {p.name}
              </Button>
            ))}
          </div>
        </>
      }
    >
      {params.get("expired") && <p className="note-info">Your session ended after a period without activity. Sign in again to carry on.</p>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void go(email, password);
        }}
        noValidate
      >
        <label className="field">
          <span>Email</span>
          <Input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required aria-invalid={!!error} aria-describedby={error ? "signin-error" : undefined} />
        </label>
        <label className="field">
          <span>Password</span>
          <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required aria-invalid={!!error} aria-describedby={error ? "signin-error" : undefined} />
        </label>
        {error && (
          <p className="note-error" id="signin-error" role="alert">
            {error}
          </p>
        )}
        <div className="row">
          <Button variant="string" type="submit" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </Button>
          <span className="muted" style={{ fontSize: 13 }}>
            New firm? <Link className="link" to="/sign-up">Set up your firm</Link>
          </span>
        </div>
      </form>
    </AuthCard>
  );
}
