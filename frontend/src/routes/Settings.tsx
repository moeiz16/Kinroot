// Settings: a paper sheet with folder tabs along its top. Firm · Members · Risk method · Screening lists ·
// Retention · Notifications.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Lock, UserPlus, X } from "lucide-react";
import { useState } from "react";
import { useNavigate, useParams } from "react-router";
import { ApiError, errorMessage } from "../api/client";
import { api } from "../api/endpoints";
import type { Role } from "../api/types";
import { fmtDate, relativeDays } from "../lib/dates";
import { ROLE_LABELS } from "../lib/permissions";
import { applyTheme, useTheme } from "../lib/theme";
import { useAuth } from "../lib/auth";
import { Status } from "../shell/chrome";
import { Sheet } from "../shell/Drawer";
import "./sheets.css";

const SECTIONS = [
  { id: "firm", label: "Firm" },
  { id: "members", label: "Members" },
  { id: "risk-method", label: "Risk method" },
  { id: "screening-lists", label: "Screening lists" },
  { id: "retention", label: "Retention" },
  { id: "notifications", label: "Notifications" },
];

export default function Settings() {
  const { section = "firm" } = useParams();
  const nav = useNavigate();
  const members = useQuery({ queryKey: ["members"], queryFn: api.org.members });
  return (
    <Sheet label="Settings" width={760}>
      <div className="tabs settings-tabs" role="tablist" aria-label="Settings sections" style={{ padding: "0 0 0 2px", margin: "-8px -32px 0", paddingLeft: 30, borderBottom: "1px solid var(--paper-edge)" }}>
        {SECTIONS.map((s) => (
          <button key={s.id} role="tab" className="tab" aria-selected={s.id === section} onClick={() => nav(`/settings/${s.id}`)}>
            {s.label}
            {s.id === "members" && members.data && <span className="n">{members.data.length}</span>}
          </button>
        ))}
      </div>
      <div style={{ paddingTop: 24 }} role="tabpanel">
        {section === "members" ? <Members /> : section === "risk-method" ? <RiskMethod /> : section === "screening-lists" ? <Lists /> : section === "retention" ? <Retention /> : section === "notifications" ? <Notifications /> : <Firm />}
      </div>
    </Sheet>
  );
}

function Firm() {
  const { me, can } = useAuth();
  const qc = useQueryClient();
  const org = useQuery({ queryKey: ["org"], queryFn: api.org.get });
  const members = useQuery({ queryKey: ["members"], queryFn: api.org.members });
  const [name, setName] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const save = useMutation({ mutationFn: () => api.org.patch({ name: name! }), onSuccess: () => { setMsg("Saved."); void qc.invalidateQueries({ queryKey: ["org"] }); void qc.invalidateQueries({ queryKey: ["me"] }); }, onError: (e) => setMsg(errorMessage(e)) });
  const o = org.data;
  if (!o) return null;
  const co = members.data?.find((m) => m.role === "compliance_officer");
  return (
    <>
      <h1 className="title">The firm</h1>
      <table className="ledger" style={{ marginTop: 14 }}>
        <tbody>
          <tr>
            <th scope="row" style={{ width: 200, paddingTop: 12 }}>Name</th>
            <td>{can("org:admin") ? <input className="input" value={name ?? o.name} onChange={(e) => setName(e.target.value)} aria-label="Firm name" /> : o.name}</td>
          </tr>
          <tr><th scope="row">Regulated under</th><td>{o.regime.name}</td></tr>
          <tr><th scope="row">Jurisdiction</th><td>{o.country === "AU" ? "Australia" : "United Kingdom"}</td></tr>
          <tr><th scope="row">ABN</th><td className="mono">{o.abn || "—"}</td></tr>
          <tr><th scope="row">Address</th><td>{o.address}</td></tr>
          <tr><th scope="row">Data stored in</th><td>{o.dataResidency === "AU" ? "Australia (Sydney)" : "United Kingdom (London)"}</td></tr>
          <tr><th scope="row">Compliance officer</th><td>{co ? `${co.fullName} · ${co.roleLabel}` : "Not set"}</td></tr>
          <tr>
            <th scope="row">Firm stamp</th>
            <td>
              <span className="stamp-preview">{o.name.replace(/\(.*\)/, "").trim().split(" ").map((w) => w[0]).slice(0, 2).join("")}</span>
            </td>
          </tr>
        </tbody>
      </table>
      {can("org:admin") && name !== null && (
        <button className="btn btn-string" style={{ marginTop: 16 }} onClick={() => save.mutate()}>
          Save the firm’s details
        </button>
      )}
      {msg && <p role="status">{msg}</p>}
      <p className="note" style={{ marginTop: 18 }}>Signed in as {me?.user.email}.</p>
    </>
  );
}

function Members() {
  const { can, me } = useAuth();
  const qc = useQueryClient();
  const members = useQuery({ queryKey: ["members"], queryFn: api.org.members });
  const invites = useQuery({ queryKey: ["invitations"], queryFn: api.org.invitations, enabled: can("members:manage") });
  const [inviting, setInviting] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("fee_earner");
  const [link, setLink] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["members"] });
    void qc.invalidateQueries({ queryKey: ["invitations"] });
  };
  const invite = useMutation({
    mutationFn: () => api.org.invite(email, role),
    onSuccess: (r) => {
      setLink(r.inviteUrl);
      setEmail("");
      setErr(null);
      refresh();
    },
    onError: (e) => setErr(e instanceof ApiError ? (e.fieldErrors().email ?? errorMessage(e)) : errorMessage(e)),
  });
  const changeRole = useMutation({ mutationFn: (v: { id: string; role: Role }) => api.org.patchMember(v.id, v.role), onSuccess: refresh, onError: (e) => setErr(errorMessage(e)) });
  const revoke = useMutation({ mutationFn: (id: string) => api.org.revokeInvitation(id), onSuccess: refresh });
  return (
    <>
      <div className="sheet-head">
        <h1 className="title">Members</h1>
        {can("members:manage") && (
          <button className="btn btn-string" onClick={() => setInviting(!inviting)}>
            <UserPlus /> Invite someone
          </button>
        )}
      </div>
      {inviting && (
        <div className="signoff" style={{ marginTop: 16 }}>
          <h3>Invite someone to the firm</h3>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 220px", gap: 10 }}>
            <label className="field">
              <span>Email</span>
              <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} aria-invalid={!!err} />
            </label>
            <label className="field">
              <span>Role</span>
              <select className="select" value={role} onChange={(e) => setRole(e.target.value as Role)}>
                {(Object.keys(ROLE_LABELS) as Role[]).map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {err && <p className="note-error" style={{ marginTop: 10 }}>{err}</p>}
          <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
            <button className="btn btn-ink" onClick={() => invite.mutate()} disabled={invite.isPending}>
              Create the invitation
            </button>
          </div>
          {link && (
            <div style={{ marginTop: 14 }}>
              <p style={{ margin: "0 0 6px" }}>Send this link to them. It is shown once and works for 7 days.</p>
              <div style={{ display: "flex", gap: 8 }}>
                <input className="input mono" readOnly value={link} aria-label="Invitation link" style={{ fontSize: 12 }} />
                <button className="btn btn-line" onClick={() => void navigator.clipboard?.writeText(link)}>
                  <Copy /> Copy
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      <table className="ledger" style={{ marginTop: 18 }}>
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Role</th>
            <th scope="col">Can see reports</th>
            <th scope="col">Training due</th>
          </tr>
        </thead>
        <tbody>
          {(members.data ?? []).map((m) => (
            <tr key={m.id}>
              <td className="who">
                <b>{m.fullName}</b>
                <small>{m.email}</small>
              </td>
              <td>
                {can("members:manage") && m.userId !== me?.user.id ? (
                  <select className="select" style={{ height: 32 }} value={m.role} aria-label={`Role for ${m.fullName}`} onChange={(e) => changeRole.mutate({ id: m.id, role: e.target.value as Role })}>
                    {(Object.keys(ROLE_LABELS) as Role[]).map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABELS[r]}
                      </option>
                    ))}
                  </select>
                ) : (
                  m.roleLabel
                )}
              </td>
              <td>{m.role === "compliance_officer" ? <Status tone="restricted">Yes</Status> : <span className="muted">—</span>}</td>
              <td className="mono" style={{ fontSize: 12.5 }}>{m.trainingDueOn ? fmtDate(m.trainingDueOn) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {can("members:manage") && !!invites.data?.length && (
        <section className="section">
          <h2>Pending invitations ({invites.data.length})</h2>
          <table className="ledger">
            <tbody>
              {invites.data.map((i) => (
                <tr key={i.id}>
                  <td className="who">
                    <b>{i.email}</b>
                    <small>{ROLE_LABELS[i.role]} · expires {relativeDays(i.expiresAt.slice(0, 10))}</small>
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <button className="btn btn-quiet btn-sm" onClick={() => revoke.mutate(i.id)}>
                      <X /> Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      <p className="note" style={{ marginTop: 16, display: "flex", gap: 6, alignItems: "center" }}>
        <Lock size={12} aria-hidden /> Only the compliance officer and the people they name can see suspicious-matter reports. Roles alone never grant it.
      </p>
    </>
  );
}

function RiskMethod() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const m = useQuery({ queryKey: ["methodology"], queryFn: api.risk.methodology });
  const publish = useMutation({ mutationFn: (id: string) => api.risk.publish(id), onSuccess: () => void qc.invalidateQueries({ queryKey: ["methodology"] }) });
  const current = m.data?.find((x) => x.status === "published");
  return (
    <>
      <h1 className="title">Risk method</h1>
      <p className="lede" style={{ fontSize: 15.5 }}>
        The firm’s rules decide every rating. A second opinion checks each one; when they disagree, the client goes to the compliance officer and the rules stay the decision of record.
      </p>
      <table className="ledger" style={{ marginTop: 16 }}>
        <tbody>
          {(m.data ?? []).map((x) => (
            <tr key={x.id}>
              <td className="who">
                <b className="mono">{x.version}</b>
                <small>{x.status === "published" ? `In use since ${fmtDate(x.publishedAt?.slice(0, 10))}, approved by ${x.publishedBy}` : x.status === "draft" ? "Draft" : "Retired"}</small>
              </td>
              <td>
                <Status tone={x.status === "published" ? "clear" : x.status === "draft" ? "review" : "neutral"}>{x.status === "published" ? "Current" : x.status === "draft" ? "Draft" : "Retired"}</Status>
              </td>
              <td style={{ textAlign: "right" }}>
                {x.status === "draft" && can("methodology:manage") && (
                  <button className="btn btn-line btn-sm" onClick={() => window.confirm(`Publish ${x.version}? Every client will be re-rated with it.`) && publish.mutate(x.id)}>
                    Publish
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {current && (
        <section className="section">
          <h2>
            Rules in {current.version} <span className="aside">Clear &lt; {current.bands.medium} ≤ Review &lt; {current.bands.high} ≤ High</span>
          </h2>
          <ol className="reasons">
            {current.rules.map((r) => (
              <li key={r.code}>
                <span>
                  {r.description} <small className="muted" style={{ fontFamily: "var(--f-sans)", fontSize: 12 }}>· {r.condition}</small>
                </span>
                <span className={`w${r.points > 0 ? " up" : ""}`}>{r.points > 0 ? `+${r.points}` : `−${Math.abs(r.points)}`}</span>
              </li>
            ))}
          </ol>
        </section>
      )}
    </>
  );
}

function Lists() {
  const { can } = useAuth();
  const lists = useQuery({ queryKey: ["lists"], queryFn: api.screening.lists });
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings.get });
  const [msg, setMsg] = useState<string | null>(null);
  const rescreen = useMutation({ mutationFn: api.screening.rescreen, onSuccess: () => setMsg("Every client is being screened again. Alerts appear for anything new."), onError: (e) => setMsg(errorMessage(e)) });
  return (
    <>
      <h1 className="title">Screening lists</h1>
      <table className="ledger" style={{ marginTop: 14 }}>
        <thead>
          <tr>
            <th scope="col">List</th>
            <th scope="col">Version</th>
            <th scope="col" className="num">Entries</th>
          </tr>
        </thead>
        <tbody>
          {(lists.data ?? []).map((l) => (
            <tr key={l.list}>
              <td className="who">
                <b>{l.list}</b>
                <small>
                  {l.source}
                  {l.sample ? " · sample data" : ""} · loaded {fmtDate(l.loadedAt.slice(0, 10))}
                </small>
              </td>
              <td className="mono">{l.version}</td>
              <td className="num">{l.entries.toLocaleString("en-AU")}</td>
            </tr>
          ))}
          <tr>
            <td className="who">
              <b>Adverse media</b>
              <small>Not connected</small>
            </td>
            <td className="muted">—</td>
            <td className="num">—</td>
          </tr>
        </tbody>
      </table>
      <p style={{ marginTop: 16 }}>
        {settings.data?.screening.autoRescreenOnListUpdate ? "Every client is screened again automatically when a list changes." : "Clients are screened when they are onboarded and at each review."} Names count as a possible match from {Math.round((settings.data?.screening.fuzzyThreshold ?? 0.82) * 100)} in 100.
      </p>
      {can("monitoring:manage") && (
        <button className="btn btn-line" onClick={() => rescreen.mutate()}>
          Screen every client now
        </button>
      )}
      {msg && <p role="status">{msg}</p>}
    </>
  );
}

function Retention() {
  const { can, me } = useAuth();
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings.get });
  const preview = useQuery({ queryKey: ["retention"], queryFn: api.settings.retentionPreview, enabled: can("retention:manage") });
  const [msg, setMsg] = useState<string | null>(null);
  const run = useMutation({ mutationFn: () => api.settings.retentionRun(true), onSuccess: () => setMsg("Dry run complete. Nothing was deleted."), onError: (e) => setMsg(errorMessage(e)) });
  const years = settings.data?.retention.years ?? 7;
  const uk = me?.activeOrg?.country === "GB";
  return (
    <>
      <h1 className="title">Retention</h1>
      <p className="lede" style={{ fontSize: 15.5 }}>
        Records are kept for {years} years after the client relationship ends ({uk ? "UK MLR 2017, regulation 40" : "AML/CTF Act record keeping"}). Nothing is deleted automatically: a person reviews the disposal list and approves it.
      </p>
      {can("retention:manage") && (
        <section className="section">
          <h2>
            Due for disposal <span className="aside">dry run</span>
          </h2>
          <table className="ledger">
            <tbody>
              {(preview.data?.items ?? []).map((i) => (
                <tr key={i.id}>
                  <td className="who">
                    <b>{i.label}</b>
                    <small>Relationship ended {fmtDate(i.relationshipEndedOn)} · can be disposed of from {fmtDate(i.disposableFrom)}</small>
                  </td>
                  <td className="st">{i.legalHold ? <Status tone="restricted">Legal hold</Status> : <Status tone="neutral">Kept</Status>}</td>
                </tr>
              ))}
              {!preview.data?.items.length && (
                <tr>
                  <td className="muted">Nothing is due.</td>
                </tr>
              )}
            </tbody>
          </table>
          <button className="btn btn-line" style={{ marginTop: 14 }} onClick={() => run.mutate()}>
            Run a dry run
          </button>
          {msg && <p role="status">{msg}</p>}
        </section>
      )}
    </>
  );
}

function Notifications() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const theme = useTheme();
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings.get });
  const [msg, setMsg] = useState<string | null>(null);
  const n = settings.data?.notifications ?? { criticalAlerts: "immediate" as const, reviewReminderDays: 30, signoffRequests: true, weeklyDigest: true, digestDay: "monday" as const };
  const canEdit = can("org:admin") || can("methodology:manage");
  const save = useMutation({
    mutationFn: (patch: Partial<typeof n>) => api.settings.patch({ notifications: { ...n, ...patch } }),
    onSuccess: (s) => {
      qc.setQueryData(["settings"], s);
      setMsg("Saved.");
    },
    onError: (e) => setMsg(errorMessage(e)),
  });
  return (
    <>
      <h1 className="title">Notifications</h1>
      <p className="lede" style={{ fontSize: 15.5 }}>What Kinroot tells the firm about by email, and when.</p>
      <div style={{ display: "grid", gap: 14, marginTop: 16, maxWidth: 520 }}>
        <label className="field">
          <span>Urgent alerts (a possible sanctions match, a confirmed match)</span>
          <select className="select" value={n.criticalAlerts} disabled={!canEdit} onChange={(e) => save.mutate({ criticalAlerts: e.target.value as typeof n.criticalAlerts })}>
            <option value="immediate">Straight away</option>
            <option value="daily">In a daily summary</option>
            <option value="off">Don’t email</option>
          </select>
        </label>
        <label className="field">
          <span>Remind fee earners before a periodic review is due (days)</span>
          <input className="input mono" type="number" min={1} max={120} value={n.reviewReminderDays} disabled={!canEdit} onChange={(e) => save.mutate({ reviewReminderDays: Number(e.target.value) })} />
        </label>
        <label className="check">
          <input type="checkbox" checked={n.signoffRequests} disabled={!canEdit} onChange={(e) => save.mutate({ signoffRequests: e.target.checked })} />
          Email the compliance officer and partners when a file waits for their sign-off
        </label>
        <label className="check">
          <input type="checkbox" checked={n.weeklyDigest} disabled={!canEdit} onChange={(e) => save.mutate({ weeklyDigest: e.target.checked })} />
          Send the partners’ brief every week on
          <select className="select" style={{ width: 140, height: 30, marginLeft: 6 }} value={n.digestDay} disabled={!canEdit || !n.weeklyDigest} onChange={(e) => save.mutate({ digestDay: e.target.value as typeof n.digestDay })} aria-label="Digest day">
            {["monday", "tuesday", "wednesday", "thursday", "friday"].map((d) => (
              <option key={d} value={d}>
                {d[0]!.toUpperCase() + d.slice(1)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {!canEdit && <p className="note" style={{ marginTop: 12 }}>The firm administrator or compliance officer changes these.</p>}
      {msg && <p role="status">{msg}</p>}
      <section className="section">
        <h2>The board</h2>
        <label className="check">
          <input type="checkbox" checked={theme === "dark"} onChange={() => applyTheme(theme === "dark" ? "light" : "dark", true)} />
          Use the dark board on this device
        </label>
      </section>
    </>
  );
}
