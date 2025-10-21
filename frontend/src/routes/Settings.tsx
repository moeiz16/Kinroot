// Settings, form skeleton: a poster title, section words (Firm · Members · Risk method · Screening lists · Retention ·
// Notifications) and each section as label/field rows on the page grid.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Lock, UserPlus, X } from "lucide-react";
import { useState } from "react";
import { useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableHead, TableHeader } from "@/components/ui/table";
import { ApiError, errorMessage } from "../api/client";
import { api } from "../api/endpoints";
import type { Role } from "../api/types";
import { dueIn, fmtDate, relativeDays } from "../lib/dates";
import { ROLE_LABELS } from "../lib/permissions";
import { listSourceLabel, ratingLook } from "../lib/format";
import { applyTheme, useTheme } from "../lib/theme";
import { useAuth } from "../lib/auth";
import { Status } from "../shell/chart";
import { Masthead, Page, SectionTabs } from "../shell/page";

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
  const { me } = useAuth();
  const members = useQuery({ queryKey: ["members"], queryFn: api.org.members });
  return (
    <Page skeleton="form" label="Settings">
      <Masthead
        size="poster"
        refLine={
          <>
            <b>Settings</b>
            <span className="sep">/</span>
            <span>{me?.activeOrg?.name}</span>
          </>
        }
        title="The firm’s settings"
      />
      <SectionTabs label="Settings" tabs={SECTIONS.map((x) => ({ ...x, count: x.id === "members" ? members.data?.length : undefined }))} active={section} onTab={(id) => nav(`/settings/${id}`)}>
        <div className="settings-body">{section === "members" ? <Members /> : section === "risk-method" ? <RiskMethod /> : section === "screening-lists" ? <Lists /> : section === "retention" ? <Retention /> : section === "notifications" ? <Notifications /> : <Firm />}</div>
      </SectionTabs>
    </Page>
  );
}

function Firm() {
  const { me, can } = useAuth();
  const qc = useQueryClient();
  const org = useQuery({ queryKey: ["org"], queryFn: api.org.get });
  const members = useQuery({ queryKey: ["members"], queryFn: api.org.members });
  const [name, setName] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const save = useMutation({ mutationFn: () => api.org.patch({ name: name! }), onSuccess: () => { toast("Saved."); void qc.invalidateQueries({ queryKey: ["org"] }); void qc.invalidateQueries({ queryKey: ["me"] }); }, onError: (e) => setMsg(errorMessage(e)) });
  const o = org.data;
  if (!o) return null;
  const co = members.data?.find((m) => m.role === "compliance_officer");
  return (
    <>
      <h2 className="title">The firm</h2>
      <Table style={{ marginTop: 14 }}>
        <TableBody>
          <tr>
            <th scope="row" style={{ width: 200, paddingTop: 12 }}>Name</th>
            <td>{can("org:admin") ? <Input value={name ?? o.name} onChange={(e) => setName(e.target.value)} aria-label="Firm name" /> : o.name}</td>
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
        </TableBody>
      </Table>
      {can("org:admin") && name !== null && (
        <Button variant="primary" style={{ marginTop: 16 }} onClick={() => save.mutate()}>
          Save the firm’s details
        </Button>
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
        <h2 className="title">Members</h2>
        {can("members:manage") && (
          <Dialog
            open={inviting}
            onOpenChange={(o) => {
              setInviting(o);
              if (!o) setLink(null);
            }}
          >
            <DialogTrigger asChild>
              <Button variant="primary">
                <UserPlus /> Invite someone
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[520px]">
              <DialogHeader>
                <DialogTitle>Invite someone to the firm</DialogTitle>
                <DialogDescription>They join with the role you choose. Access to restricted reports is never part of a role.</DialogDescription>
              </DialogHeader>
              <div className="grid gap-3 sm:grid-cols-[1fr_200px]">
                <label className="field">
                  <span>Email</span>
                  <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} aria-invalid={!!err} />
                </label>
                <label className="field">
                  <span>Role</span>
                  <Select value={role} onValueChange={(v) => setRole(v as Role)}>
                    <SelectTrigger aria-label="Role" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(Object.keys(ROLE_LABELS) as Role[]).map((r) => (
                        <SelectItem key={r} value={r}>
                          {ROLE_LABELS[r]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </label>
              </div>
              {err && <p className="note-error">{err}</p>}
              {link && (
                <div>
                  <p style={{ margin: "0 0 6px" }}>Send this link to them. It is shown once and works for 7 days.</p>
                  <div style={{ display: "flex", gap: 8 }}>
                    <Input className="mono text-[12.5px]" readOnly value={link} aria-label="Invitation link" />
                    <Button onClick={() => void navigator.clipboard?.writeText(link)}>
                      <Copy /> Copy
                    </Button>
                  </div>
                </div>
              )}
              <DialogFooter>
                <Button variant="quiet" onClick={() => setInviting(false)}>
                  Close
                </Button>
                <Button variant="ink" onClick={() => invite.mutate()} disabled={invite.isPending}>
                  Create the invitation
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
      </div>
      <Table style={{ marginTop: 18 }}>
        <TableHeader>
          <tr>
            <TableHead scope="col">Name</TableHead>
            <TableHead scope="col">Role</TableHead>
            <TableHead scope="col">Can see reports</TableHead>
            <TableHead scope="col">Training due</TableHead>
          </tr>
        </TableHeader>
        <TableBody>
          {(members.data ?? []).map((m) => (
            <tr key={m.id}>
              <td className="who">
                <b>{m.fullName}</b>
                <small>{m.email}</small>
              </td>
              <td>
                {can("members:manage") && m.userId !== me?.user.id ? (
                  <Select value={m.role} onValueChange={(v) => changeRole.mutate({ id: m.id, role: v as Role })}>
                    <SelectTrigger size="sm" aria-label={`Role for ${m.fullName}`} className="w-[210px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(Object.keys(ROLE_LABELS) as Role[]).map((r) => (
                        <SelectItem key={r} value={r}>
                          {ROLE_LABELS[r]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  m.roleLabel
                )}
              </td>
              <td>{m.role === "compliance_officer" ? <Status tone="restricted">Yes</Status> : <span className="muted">—</span>}</td>
              <td className="mono" style={{ fontSize: 13 }} title={m.trainingDueOn ? fmtDate(m.trainingDueOn) : undefined}>
                {m.trainingDueOn ? dueIn(m.trainingDueOn) : "—"}
              </td>
            </tr>
          ))}
        </TableBody>
      </Table>
      {can("members:manage") && !!invites.data?.length && (
        <section className="section">
          <h2>Pending invitations ({invites.data.length})</h2>
          <Table>
            <TableBody>
              {invites.data.map((i) => (
                <tr key={i.id}>
                  <td className="who">
                    <b>{i.email}</b>
                    <small>{ROLE_LABELS[i.role]} · expires {relativeDays(i.expiresAt.slice(0, 10))}</small>
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <Button variant="quiet" size="sm" onClick={() => revoke.mutate(i.id)}>
                      <X /> Revoke
                    </Button>
                  </td>
                </tr>
              ))}
            </TableBody>
          </Table>
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
      <h2 className="title">Risk method</h2>
      <p className="lede" style={{ fontSize: 15.5 }}>
        The firm’s rules decide every rating. A second opinion checks each one; when they disagree, the client goes to the compliance officer and the rules stay the decision of record.
      </p>
      <Table style={{ marginTop: 16 }}>
        <TableBody>
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
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button size="sm">Publish</Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Publish {x.version}?</AlertDialogTitle>
                        <AlertDialogDescription>Every client will be re-rated with it. The current version is retired and kept on record.</AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Not yet</AlertDialogCancel>
                        <AlertDialogAction onClick={() => publish.mutate(x.id)}>Publish</AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                )}
              </td>
            </tr>
          ))}
        </TableBody>
      </Table>
      {current && (
        <section className="section">
          <h2>
            Rules in {current.version} <span className="aside">Clear &lt; {current.bands.medium} ≤ Review &lt; {current.bands.high} ≤ High</span>
          </h2>
          <ol className="reasons">
            {current.rules.map((r) => (
              <li key={r.code}>
                <span>{r.description}</span>
                <span className={`w${r.points > 0 ? " up" : ""}`}>{r.points > 0 ? `+${r.points}` : `−${Math.abs(r.points)}`}</span>
              </li>
            ))}
          </ol>
        </section>
      )}
      <Differences />
      <Registry />
    </>
  );
}

/** Clients where the rules and the second-opinion check disagree, waiting for the compliance officer. */
function Differences() {
  const { can } = useAuth();
  const nav = useNavigate();
  const open = useQuery({ queryKey: ["disagreements", "open"], queryFn: () => api.risk.disagreements("open"), enabled: can("risk:read") });
  const items = open.data?.items ?? [];
  return (
    <section className="section">
      <h2>
        Where the second opinion differs <span className="aside">{items.length ? `${items.length} open` : "None open"}</span>
      </h2>
      {items.length ? (
        <Table>
          <TableBody>
            {items.map((d) => (
              <tr key={d.id}>
                <td className="who">
                  <b>{d.clientName}</b>
                  <small>
                    Rules: {ratingLook(d.rulesRating).word} · second opinion: {ratingLook(d.challengerRating).word} ({Math.round(d.probabilityHigh * 100)} in 100 for high risk)
                  </small>
                </td>
                <td style={{ textAlign: "right" }}>
                  <Button variant="link" onClick={() => nav(`/clients/${d.clientId}/risk`)}>
                    {can("risk:override") ? "Settle it →" : "Open →"}
                  </Button>
                </td>
              </tr>
            ))}
          </TableBody>
        </Table>
      ) : (
        <p className="muted" style={{ fontSize: 13.5 }}>
          The rules and the second-opinion check agree on every client.
        </p>
      )}
    </section>
  );
}

const CHECK_NAME: Record<string, { title: string; lede: string }> = {
  "risk-challenger": { title: "Second-opinion risk check", lede: "Reads each client’s structure and services and says whether it looks high risk. It never changes a rating on its own." },
  "er-matcher": { title: "Duplicate matching", lede: "Scores how likely two records are the same person or company. Below the lower line they stay apart; above the upper line they are fused, unless anything conflicts." },
};
const pct100 = (v: number | undefined) => (v == null ? "—" : `${Math.round(v * 100)} in 100`);
function checkFacts(name: string, m: Record<string, number>): string {
  if (name === "er-matcher") return `Finds ${pct100(m.recallAtReview)} true duplicates · ${pct100(m.reviewRate)} of pairs need a person · wrong fusions avoided ${pct100(m.autoMergePrecision)} times`;
  return `Ranks a high-risk client above a lower-risk one ${pct100(m.rocAuc)} times · right ${pct100(m.precision)} times when it says high`;
}

/** Which version of each check the firm uses; a compliance officer can switch with a recorded reason. */
function Registry() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const models = useQuery({ queryKey: ["models"], queryFn: api.risk.models, enabled: can("models:read") });
  const [picking, setPicking] = useState<{ name: string; version: string } | null>(null);
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const promote = useMutation({
    mutationFn: () => api.risk.promote(picking!.name, picking!.version, note.trim()),
    onSuccess: () => {
      setMsg("Switched. The reason is in the activity log, and only this firm uses the new version.");
      setPicking(null);
      setNote("");
      void qc.invalidateQueries({ queryKey: ["models"] });
    },
    onError: (e) => setMsg(errorMessage(e)),
  });
  if (!models.data?.length) return null;
  return (
    <section className="section">
      <h2>
        The checks behind the ratings <span className="aside">Versions in use at this firm</span>
      </h2>
      {models.data.map((m) => (
        <div key={m.name} style={{ marginBottom: 18 }}>
          <p style={{ margin: "0 0 4px", fontWeight: 600 }}>{CHECK_NAME[m.name]?.title ?? m.name}</p>
          <p className="muted" style={{ margin: "0 0 8px", fontSize: 13 }}>
            {CHECK_NAME[m.name]?.lede}
          </p>
          <Table>
            <TableBody>
              {m.versions.map((v) => (
                <tr key={v.version}>
                  <td className="who">
                    <b>
                      <span className="mono">v{v.version.replace(/^[a-z]+-/, "").replace(/-logreg$/, "")}</span> · {v.kind === "logreg" ? "simple scorecard" : "detailed pattern check"}
                    </b>
                    <small>
                      {checkFacts(m.name, v.metrics)}
                      {v.stage === "champion" ? ` · inputs ${v.drift.status === "stable" ? "steady" : v.drift.status === "watch" ? "shifting a little" : "shifted: needs a look"}` : ""}
                      {v.promotedBy ? ` · chosen by ${v.promotedBy}` : ""}
                    </small>
                  </td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    {v.stage === "champion" ? (
                      <Status tone="clear">In use</Status>
                    ) : can("models:promote") ? (
                      <Button size="sm" onClick={() => setPicking({ name: m.name, version: v.version })}>
                        Use this version
                      </Button>
                    ) : (
                      <Status tone="neutral">{v.stage === "retired" ? "Retired" : "Standby"}</Status>
                    )}
                  </td>
                </tr>
              ))}
            </TableBody>
          </Table>
          {picking?.name === m.name && (
            <div style={{ marginTop: 10 }}>
              <label className="field">
                <span>Why switch? (at least 10 characters, kept in the activity log)</span>
                <Input value={note} onChange={(e) => setNote(e.target.value)} />
              </label>
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <Button variant="ink" size="sm" disabled={note.trim().length < 10 || promote.isPending} onClick={() => promote.mutate()}>
                  Switch for this firm
                </Button>
                <Button variant="quiet" size="sm" onClick={() => setPicking(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
      ))}
      {msg && (
        <p role="status" className="note">
          {msg}
        </p>
      )}
    </section>
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
      <h2 className="title">Screening lists</h2>
      <Table style={{ marginTop: 14 }}>
        <TableHeader>
          <tr>
            <TableHead scope="col">List</TableHead>
            <TableHead scope="col">Version</TableHead>
            <TableHead scope="col" className="num">Entries</TableHead>
          </tr>
        </TableHeader>
        <TableBody>
          {(lists.data ?? []).map((l) => (
            <tr key={l.list}>
              <td className="who">
                <b>{l.title ?? (l.list === "pep" ? "PEP list" : "Sanctions list")}</b>
                <small>
                  {listSourceLabel(l.source)} · loaded {fmtDate(l.loadedAt.slice(0, 10))}
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
        </TableBody>
      </Table>
      <section className="section" style={{ marginTop: 22 }}>
        <h2>Sources</h2>
        <ul className="sources">
          {[...new Map((lists.data ?? []).map((l) => [l.attribution ?? l.source, l])).values()].map((l) => (
            <li key={l.attribution ?? l.source}>
              <b>{listSourceLabel(l.source)}</b>
              {l.licence && l.licence !== "sample" ? <span className="mono"> · {l.licence}</span> : null}
              <p>{l.attribution ?? "Supplied with Kinroot."}</p>
            </li>
          ))}
        </ul>
      </section>
      <p style={{ marginTop: 16 }}>
        {settings.data?.screening.autoRescreenOnListUpdate ? "Every client is screened again automatically when a list changes." : "Clients are screened when they are onboarded and at each review."} Names count as a possible match from {Math.round((settings.data?.screening.fuzzyThreshold ?? 0.82) * 100)} in 100.
      </p>
      {can("monitoring:manage") && (
        <Button onClick={() => rescreen.mutate()}>Screen every client now</Button>
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
      <h2 className="title">Retention</h2>
      <p className="lede" style={{ fontSize: 15.5 }}>
        Records are kept for {years} years after the client relationship ends ({uk ? "UK MLR 2017, regulation 40" : "AML/CTF Act record keeping"}). Nothing is deleted automatically: a person reviews the disposal list and approves it.
      </p>
      {can("retention:manage") && (
        <section className="section">
          <h2>
            Due for disposal <span className="aside">dry run</span>
          </h2>
          <Table>
            <TableBody>
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
            </TableBody>
          </Table>
          <Button style={{ marginTop: 14 }} onClick={() => run.mutate()}>
            Run a dry run
          </Button>
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
      toast("Saved.");
    },
    onError: (e) => setMsg(errorMessage(e)),
  });
  return (
    <>
      <h2 className="title">Notifications</h2>
      <p className="lede" style={{ fontSize: 15.5 }}>What Kinroot tells the firm about by email, and when.</p>
      <div style={{ display: "grid", gap: 14, marginTop: 16, maxWidth: 520 }}>
        <label className="field">
          <span>Urgent alerts (a possible sanctions match, a confirmed match)</span>
          <Select value={n.criticalAlerts} disabled={!canEdit} onValueChange={(v) => save.mutate({ criticalAlerts: v as typeof n.criticalAlerts })}>
            <SelectTrigger aria-label="Urgent alerts" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="immediate">Straight away</SelectItem>
              <SelectItem value="daily">In a daily summary</SelectItem>
              <SelectItem value="off">Don’t email</SelectItem>
            </SelectContent>
          </Select>
        </label>
        <label className="field">
          <span>Remind fee earners before a periodic review is due (days)</span>
          <Input className="mono" type="number" min={1} max={120} value={n.reviewReminderDays} disabled={!canEdit} onChange={(e) => save.mutate({ reviewReminderDays: Number(e.target.value) })} />
        </label>
        <label className="check">
          <Checkbox checked={n.signoffRequests} disabled={!canEdit} onCheckedChange={(v) => save.mutate({ signoffRequests: v === true })} />
          Email the compliance officer and partners when a file waits for their sign-off
        </label>
        <label className="check">
          <Checkbox checked={n.weeklyDigest} disabled={!canEdit} onCheckedChange={(v) => save.mutate({ weeklyDigest: v === true })} />
          Send the partners’ brief every week on
          <Select value={n.digestDay} disabled={!canEdit || !n.weeklyDigest} onValueChange={(v) => save.mutate({ digestDay: v as typeof n.digestDay })}>
            <SelectTrigger size="sm" aria-label="Digest day" className="ml-1.5 w-[140px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {["monday", "tuesday", "wednesday", "thursday", "friday"].map((d) => (
                <SelectItem key={d} value={d}>
                  {d[0]!.toUpperCase() + d.slice(1)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
      </div>
      {!canEdit && <p className="note" style={{ marginTop: 12 }}>The firm administrator or compliance officer changes these.</p>}
      {msg && <p role="status">{msg}</p>}
      <section className="section">
        <h2>Pages</h2>
        <label className="check">
          <Checkbox checked={theme === "dark"} onCheckedChange={() => applyTheme(theme === "dark" ? "light" : "dark", true)} />
          Use dark pages on this device
        </label>
      </section>
    </>
  );
}
