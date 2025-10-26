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
      title="Sign in"
      foot={
        <>
          <span>
            New firm?{" "}
            <Link className="link" to="/sign-up">
              Set up
            </Link>
          </span>
        </>
      }
    >
      {params.get("expired") && <p className="note-info">Your session ended. Sign in again.</p>}
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
        <Button variant="primary" type="submit" disabled={busy} className="w-full">
          {busy ? "Signing in…" : "Sign in"}
        </Button>
      </form>
      <details className="demo" open={params.get("demo") === "1" || undefined}>
        <summary>Use a sample account</summary>
        <div className="demo-roles">
          {DEMO_PEOPLE.map((p) => (
            <button key={p.email} type="button" className="demo-role" onClick={() => go(p.email, DEMO_PASSWORD)} disabled={busy}>
              <b>{p.role}</b>
              <span>{p.name}</span>
            </button>
          ))}
        </div>
      </details>
    </AuthCard>
  );
}
