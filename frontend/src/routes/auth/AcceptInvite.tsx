import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ApiError, errorMessage } from "../../api/client";
import { api } from "../../api/endpoints";
import { fmtDate } from "../../lib/dates";
import { useAuth } from "../../lib/auth";
import { AuthCard } from "./AuthCard";

export default function AcceptInvite() {
  const { token = "" } = useParams();
  const { me, setMe } = useAuth();
  const nav = useNavigate();
  const inv = useQuery({ queryKey: ["invitation", token], queryFn: () => api.invitations.get(token), retry: false });
  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (inv.isError)
    return (
      <AuthCard tab="Invitation" title="This invitation can’t be used">
        <p>It may have expired or already been accepted. Ask the person who invited you to send a new one.</p>
        <Link className="link" to="/sign-in">
          Go to sign in
        </Link>
      </AuthCard>
    );
  if (!inv.data) return <AuthCard tab="Invitation" title="Opening your invitation…">{null}</AuthCard>;
  const i = inv.data;
  const signedInAsInvitee = me?.user.email === i.email;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.auth.csrf().catch(() => undefined);
      setMe(await api.invitations.accept(token, signedInAsInvitee ? {} : { fullName, password }));
      nav("/board");
    } catch (err) {
      if (err instanceof ApiError && err.problem.errors?.length) setErrors(err.fieldErrors());
      else setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthCard tab="Invitation" title={`Join ${i.orgName}`}>
      <p style={{ marginTop: -8 }}>
        You’ve been invited as <b>{i.roleLabel}</b> using <span className="mono">{i.email}</span>. The invitation is open until {fmtDate(i.expiresAt.slice(0, 10))}.
      </p>
      <form onSubmit={submit} noValidate>
        {!signedInAsInvitee && (
          <>
            <label className="field">
              <span>Your name</span>
              <input className="input" autoComplete="name" value={fullName} onChange={(e) => setFullName(e.target.value)} aria-invalid={!!errors.fullName} />
              {errors.fullName && <span className="note-error">{errors.fullName}</span>}
            </label>
            <label className="field">
              <span>Choose a password (12 characters or more)</span>
              <input className="input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} aria-invalid={!!errors.password} />
              {errors.password && <span className="note-error">{errors.password}</span>}
            </label>
          </>
        )}
        {error && <p className="note-error" role="alert">{error}</p>}
        <div className="row">
          <button className="btn btn-string" type="submit" disabled={busy}>
            {busy ? "Joining…" : `Join ${i.orgName.split(" (")[0]}`}
          </button>
        </div>
      </form>
    </AuthCard>
  );
}
