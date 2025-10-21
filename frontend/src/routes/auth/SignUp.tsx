import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { ApiError, errorMessage } from "../../api/client";
import { api } from "../../api/endpoints";
import type { Country } from "../../api/types";
import { useAuth } from "../../lib/auth";
import { AuthCard } from "./AuthCard";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export default function SignUp() {
  const { setMe } = useAuth();
  const nav = useNavigate();
  const [f, setF] = useState({ fullName: "", email: "", firmName: "", country: "AU" as Country, password: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const local: Record<string, string> = {};
    if (!f.fullName.trim()) local.fullName = "Enter your name.";
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email)) local.email = "Enter an email address.";
    if (!f.firmName.trim()) local.firmName = "Enter your firm's name.";
    if (f.password.length < 12) local.password = "Use at least 12 characters.";
    setErrors(local);
    if (Object.keys(local).length) return;
    setBusy(true);
    setError(null);
    try {
      await api.auth.csrf().catch(() => undefined);
      setMe(await api.auth.signup(f));
      nav("/board");
    } catch (err) {
      if (err instanceof ApiError && err.problem.errors?.length) setErrors(err.fieldErrors());
      else setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const field = (k: keyof typeof f, label: string, type = "text", auto?: string) => (
    <label className="field">
      <span>{label}</span>
      <Input type={type} autoComplete={auto} value={f[k]} onChange={set(k)} aria-invalid={!!errors[k]} aria-describedby={errors[k] ? `err-${k}` : undefined} />
      {errors[k] && (
        <span className="note-error" id={`err-${k}`}>
          {errors[k]}
        </span>
      )}
    </label>
  );
  return (
    <AuthCard tab="Set up" title="Set up your firm on Kinroot" foot={<span className="muted" style={{ fontSize: 13 }}>Already set up? <Link className="link" to="/sign-in">Sign in</Link></span>}>
      <form onSubmit={submit} noValidate>
        {field("fullName", "Your name", "text", "name")}
        {field("email", "Work email", "email", "email")}
        {field("firmName", "Firm name", "text", "organization")}
        <label className="field">
          <span>Where the firm is regulated</span>
          <Select value={f.country} onValueChange={(v) => setF({ ...f, country: v as Country })}>
            <SelectTrigger aria-label="Where the firm is regulated" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="AU">Australia (AML/CTF Act 2006, Tranche 2)</SelectItem>
              <SelectItem value="GB">United Kingdom (MLR 2017)</SelectItem>
            </SelectContent>
          </Select>
        </label>
        {field("password", "Password (12 characters or more)", "password", "new-password")}
        {error && <p className="note-error" role="alert">{error}</p>}
        <div className="row">
          <Button variant="primary" type="submit" disabled={busy}>
            {busy ? "Setting up…" : "Set up the firm"}
          </Button>
        </div>
      </form>
    </AuthCard>
  );
}
