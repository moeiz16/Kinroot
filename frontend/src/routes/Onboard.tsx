// Onboarding: the form lives in the drawer and the board builds the structure live as owners are added (each new
// party unfolds under the pin). Steps are folder tabs, not a stepper bar.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BadgeCheck, Link2, Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { ApiError, errorMessage } from "../api/client";
import { api } from "../api/endpoints";
import type { Client, ClientKind, Onboarding, Service } from "../api/types";
import { applyPositions, layered } from "../graph/layout";
import type { BEdge, BKind, BNode, Scene } from "../graph/model";
import { initials } from "../graph/transforms";
import { today } from "../lib/dates";
import { KIND_LABEL, SERVICE_LABEL } from "../lib/format";
import { useBoardHandlers, useBoardScene } from "../shell/board";
import { BoardTools, RatingTag, Status } from "../shell/chrome";
import { Drawer } from "../shell/Drawer";
import { ReasonList } from "./dossier/panels";
import { useStructure } from "./dossier/structure";
import "./sheets.css";

type Role = "owner" | "director" | "trustee" | "appointor" | "partner" | "beneficiary" | "unit_holder";
const ROLES: Record<ClientKind, Role[]> = {
  individual: [],
  company: ["owner", "director"],
  trust: ["trustee", "appointor", "beneficiary", "unit_holder"],
  partnership: ["partner"],
};
const ROLE_LABEL: Record<Role, string> = { owner: "Shareholder", director: "Director", trustee: "Trustee", appointor: "Appointor", partner: "Partner", beneficiary: "Beneficiary", unit_holder: "Unit holder" };
const HOLDS: Role[] = ["owner", "partner", "beneficiary", "unit_holder"];
/** The contract's interest codes for each holding role (docs/API_CONTRACT.md 1.6). */
const INTEREST: Partial<Record<Role, string>> = { owner: "shares", partner: "partnership", beneficiary: "trust_entitlement", unit_holder: "units" };

export interface DraftParty {
  key: string;
  kind: "person" | "company" | "trust";
  name: string;
  role: Role;
  pct?: number;
  birthDate?: string;
  serverId?: string;
  dupOf?: { id: string; name: string };
  verified?: boolean;
  partial?: boolean;
  street?: string;
  suburb?: string;
  postcode?: string;
  docType?: string;
  docNo?: string;
  consent?: boolean;
}
interface DraftClient {
  kind: ClientKind;
  name: string;
  state: string;
  street: string;
  suburb: string;
  postcode: string;
  identifier: string;
  services: Service[];
  channel: Client["channel"];
  matterReference: string;
  birthDate: string;
}

/** The structure as it is being typed: client pin on top, every added party unfolding beneath it. */
export function draftScene(c: DraftClient, parties: DraftParty[], canAdd: boolean): Scene {
  const cKind: BKind = c.kind === "individual" ? "person" : c.kind;
  const nodes: BNode[] = [
    { id: "client", kind: cKind, client: true, label: c.name || "New client", sub: c.identifier || KIND_LABEL[c.kind], glyph: c.kind === "individual" ? initials(c.name || "N C") : c.kind === "trust" ? "T" : c.kind === "partnership" ? "P" : "AU", level: 0, flags: [], aria: `${c.name || "New client"}, client`, x: 0, y: 0 },
  ];
  const edges: BEdge[] = [];
  parties.forEach((p) => {
    nodes.push({
      id: p.key,
      kind: p.kind,
      label: p.name || "Unnamed",
      sub: ROLE_LABEL[p.role] + (p.pct ? ` · ${p.pct}%` : ""),
      glyph: p.kind === "person" ? initials(p.name || "?") : p.kind === "trust" ? "T" : "AU",
      level: 1,
      from: "client",
      flags: p.dupOf ? [{ text: "◆ Possible duplicate", level: "review" }] : [],
      aria: `${p.name}, ${ROLE_LABEL[p.role]}`,
      x: 0,
      y: 0,
    });
    edges.push(HOLDS.includes(p.role) ? { id: `e-${p.key}`, s: p.key, t: "client", kind: p.pct ? "own" : "unknown", label: p.pct ? `${p.pct}%` : "?%", pct: p.pct ?? null } : { id: `e-${p.key}`, s: p.key, t: "client", kind: "ctrl", label: ROLE_LABEL[p.role] });
  });
  if (canAdd) nodes.push({ id: "ghost", kind: "unknown", label: "Add an owner", sub: "or controller", glyph: "+", level: 1, from: "client", flags: [], aria: "Add an owner or controller", x: 0, y: 0 });
  return { key: "onboard-draft", nodes: applyPositions(nodes, layered(nodes, edges, { nodeSep: 215 })), edges };
}

// Consent comes before the identity check: the collection notice is given, and consent to an electronic check
// recorded, before anyone's details are checked against an issuer (Privacy Act 1988; AML/CTF Rules safe harbour).
const STEPS = [
  { id: "client", label: "1 Client" },
  { id: "people", label: "2 People and owners" },
  { id: "consent", label: "3 Consent" },
  { id: "identity", label: "4 Identity" },
  { id: "review", label: "5 Review" },
];
const addressOf = (street: string | undefined, suburb: string | undefined, postcode: string | undefined, state: string) =>
  street?.trim() ? { line1: street.trim(), locality: suburb?.trim() || undefined, state, postcode: postcode?.trim() || undefined, country: "AU" } : undefined;

export default function Onboard() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [step, setStep] = useState("client");
  const [c, setC] = useState<DraftClient>({ kind: "trust", name: "", state: "NSW", identifier: "", services: ["property_transaction"], channel: "face_to_face", matterReference: "", birthDate: "", street: "", suburb: "", postcode: "" });
  const [parties, setParties] = useState<DraftParty[]>([]);
  const [client, setClient] = useState<Client | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<Client | null>(null);
  const [checklist, setChecklist] = useState<Onboarding | null>(null);
  const risk = useQuery({ queryKey: ["risk", submitted?.id], queryFn: () => api.clients.risk(submitted!.id), enabled: !!submitted });
  const { structure } = useStructure(submitted?.id, null);
  const draft = useMemo(() => draftScene(c, parties, step === "people" && c.kind !== "individual"), [c, parties, step]);
  useBoardScene(submitted && structure ? structure.scene : draft, { unfold: !!submitted, strings: submitted ? structure?.strings : null });
  const addParty = (kind: DraftParty["kind"]) => setParties((ps) => [...ps, { key: `d${Date.now()}`, kind, name: "", role: ROLES[c.kind][0] ?? "owner" }]);
  useBoardHandlers({ onActivate: (id) => id === "ghost" && addParty("person") });
  const set = (k: string, patch: Partial<DraftParty>) => setParties((ps) => ps.map((p) => (p.key === k ? { ...p, ...patch } : p)));

  const checkDuplicate = async (p: DraftParty) => {
    if (p.kind !== "person" || p.name.trim().length < 4) return;
    const hits = await api.graph.search(p.name.trim().split(" ").pop()!, 8).catch(() => []);
    const first = p.name.trim()[0]?.toLowerCase();
    const dup = hits.find((h) => h.kind === "person" && h.label[0]?.toLowerCase() === first && h.label.toLowerCase() !== p.name.trim().toLowerCase());
    set(p.key, { dupOf: dup ? { id: dup.id, name: dup.label } : undefined });
  };

  const create = useMutation({
    mutationFn: async () => {
      if (!c.name.trim()) throw new Error("Enter the client's name.");
      if (client) return client;
      const id = c.identifier.replace(/\s/g, "");
      const made = await api.clients.create({
        kind: c.kind,
        name: c.name.trim(),
        jurisdiction: "AU",
        services: c.services,
        channel: c.channel,
        matterReference: c.matterReference || undefined,
        identifiers: c.kind === "company" ? { acn: c.identifier } : c.kind !== "individual" && id ? { abn: c.identifier } : undefined,
        person: c.kind === "individual" ? { givenNames: c.name.split(" ").slice(0, -1).join(" "), familyName: c.name.split(" ").pop() ?? "", birthDate: c.birthDate, nationality: "AU", address: addressOf(c.street, c.suburb, c.postcode, c.state) } : undefined,
      });
      setClient(made);
      return made;
    },
    onSuccess: () => {
      setErr(null);
      setStep(c.kind === "individual" ? "consent" : "people");
    },
    onError: (e) => setErr(e instanceof ApiError ? (e.fieldErrors().name ?? errorMessage(e)) : (e as Error).message),
  });

  const saveParties = useMutation({
    mutationFn: async () => {
      if (!client) throw new Error("Save the client first.");
      const held = parties.filter((p) => HOLDS.includes(p.role)).reduce((a, p) => a + (p.pct ?? 0), 0);
      if (held > 100) throw new Error(`Shares add up to ${held}%. They can’t be more than 100%.`);
      for (const p of parties) {
        if (p.serverId) continue;
        if (!p.name.trim()) throw new Error("Every person or entity needs a name.");
        const party = await api.clients.addParty(client.id, { kind: p.kind, name: p.name.trim(), birthDate: p.birthDate || undefined, jurisdiction: "AU", address: p.kind === "person" ? addressOf(p.street, p.suburb, p.postcode, c.state) : undefined });
        await api.relationships.create(
          HOLDS.includes(p.role)
            ? { fromPartyId: party.id, toPartyId: client.partyId, kind: "ownership", pct: p.pct || undefined, interest: INTEREST[p.role], validFrom: today() }
            : { fromPartyId: party.id, toPartyId: client.partyId, kind: "control", role: p.role, validFrom: today() },
        );
        set(p.key, { serverId: party.id });
      }
    },
    onSuccess: () => {
      setErr(null);
      setStep("consent");
    },
    onError: (e) => setErr(e instanceof ApiError ? errorMessage(e) : (e as Error).message),
  });

  const verify = useMutation({
    mutationFn: async (p: { key: string; partyId: string }) => {
      const check = await api.clients.verify(client!.id, { partyId: p.partyId, method: "electronic", documentIds: [] });
      return { key: p.key, ok: check.result === "verified" };
    },
    onSuccess: ({ key, ok }) => {
      setErr(null);
      if (key === "client") setClientVerified(ok);
      else set(key, { verified: ok, partial: !ok });
    },
    onError: (e) => setErr(errorMessage(e)),
  });
  const [clientVerified, setClientVerified] = useState(false);

  const consent = useMutation({
    mutationFn: async () => {
      const people = parties.filter((p) => p.kind === "person" && p.consent && p.serverId);
      const ids = [...people.map((p) => p.serverId!), ...(c.kind === "individual" && clientConsent ? [client!.partyId] : [])];
      for (const partyId of ids)
        for (const purpose of ["identity_verification", "electronic_check"] as const) await api.clients.consent(client!.id, { partyId, purpose, givenOn: today(), method: "online form" });
    },
    onSuccess: () => {
      setErr(null);
      setStep("identity");
    },
    onError: (e) => setErr(errorMessage(e)),
  });
  const [clientConsent, setClientConsent] = useState(false);

  const toReview = useMutation({
    mutationFn: () => api.clients.onboarding(client!.id),
    onSuccess: (o) => {
      setChecklist(o);
      setStep("review");
    },
    onError: (e) => setErr(errorMessage(e)),
  });
  const submit = useMutation({
    mutationFn: () => api.clients.submit(client!.id),
    onSuccess: (res) => {
      setSubmitted(res.client);
      void qc.invalidateQueries({ queryKey: ["clients"] });
      void qc.invalidateQueries({ queryKey: ["constellation"] });
      void qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (e) => setErr(e instanceof ApiError && e.code === "invalid_transition" ? "Some required items are still open. Finish them, then try again." : errorMessage(e)),
  });

  const toVerify: { key: string; partyId?: string; name: string; kind: string; verified: boolean; partial?: boolean }[] = [
    ...(c.kind === "individual" || parties.length === 0 ? [{ key: "client", partyId: client?.partyId, name: c.name, kind: c.kind === "individual" ? "person" : "entity", verified: clientVerified }] : []),
    ...parties.map((p) => ({ key: p.key, partyId: p.serverId, name: p.name, kind: p.kind, verified: !!p.verified, partial: !!p.partial })),
  ];

  return (
    <>
      <BoardTools minimap={false} />
      <Drawer label="Onboard a client" tabs={STEPS} active={step} onTab={(s) => (client || s === "client" ? setStep(s) : undefined)} onClose={() => nav("/board")}>
        {err && (
          <p className="note-error" role="alert" style={{ marginBottom: 14 }}>
            {err}
          </p>
        )}
        {step === "client" && (
          <>
            <h1 className="title" style={{ fontSize: 26 }}>
              Who is the client?
            </h1>
            <div role="radiogroup" aria-label="Client type" className="kind-pick">
              {(Object.keys(KIND_LABEL) as ClientKind[]).map((k) => (
                <button key={k} role="radio" aria-checked={c.kind === k} className={`btn btn-sm ${c.kind === k ? "btn-ink" : "btn-line"}`} onClick={() => !client && setC({ ...c, kind: k })} disabled={!!client && c.kind !== k}>
                  {KIND_LABEL[k]}
                </button>
              ))}
            </div>
            <div style={{ display: "grid", gap: 14, marginTop: 16 }}>
              <label className="field">
                <span>{c.kind === "individual" ? "Full name" : "Legal name"}</span>
                <input className="input" value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} disabled={!!client} />
              </label>
              {c.kind === "individual" ? (
                <>
                  <label className="field">
                    <span>Date of birth</span>
                    <input className="input" type="date" value={c.birthDate} onChange={(e) => setC({ ...c, birthDate: e.target.value })} disabled={!!client} />
                  </label>
                  <label className="field">
                    <span>Residential address</span>
                    <input className="input" value={c.street} placeholder="Street" onChange={(e) => setC({ ...c, street: e.target.value })} disabled={!!client} />
                  </label>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 120px", gap: 10 }}>
                    <label className="field">
                      <span>Suburb</span>
                      <input className="input" value={c.suburb} onChange={(e) => setC({ ...c, suburb: e.target.value })} disabled={!!client} />
                    </label>
                    <label className="field">
                      <span>Postcode</span>
                      <input className="input mono" inputMode="numeric" maxLength={4} value={c.postcode} onChange={(e) => setC({ ...c, postcode: e.target.value })} disabled={!!client} />
                    </label>
                  </div>
                </>
              ) : (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 120px", gap: 10 }}>
                  <label className="field">
                    <span>{c.kind === "company" ? "ACN" : "ABN"}</span>
                    <input className="input mono" value={c.identifier} onChange={(e) => setC({ ...c, identifier: e.target.value })} disabled={!!client} />
                  </label>
                  <label className="field">
                    <span>State</span>
                    <select className="select" value={c.state} onChange={(e) => setC({ ...c, state: e.target.value })} disabled={!!client}>
                      {["NSW", "VIC", "QLD", "WA", "SA", "TAS", "ACT", "NT"].map((s) => (
                        <option key={s}>{s}</option>
                      ))}
                    </select>
                  </label>
                </div>
              )}
              <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
                <legend style={{ font: "600 12.5px/1.2 var(--f-sans)", color: "var(--ink-2)", marginBottom: 8 }}>What the firm will do for them</legend>
                <div className="svc-grid">
                  {(["property_transaction", "conveyancing", "managing_client_funds", "company_formation", "trust_formation", "tax_advice"] as Service[]).map((s) => (
                    <label key={s} className="check">
                      <input type="checkbox" checked={c.services.includes(s)} disabled={!!client} onChange={() => setC({ ...c, services: c.services.includes(s) ? c.services.filter((x) => x !== s) : [...c.services, s] })} />
                      {SERVICE_LABEL[s]}
                    </label>
                  ))}
                </div>
              </fieldset>
              <label className="field">
                <span>How you met them</span>
                <select className="select" value={c.channel} onChange={(e) => setC({ ...c, channel: e.target.value as Client["channel"] })} disabled={!!client}>
                  <option value="face_to_face">In person</option>
                  <option value="remote">Remotely</option>
                  <option value="intermediary">Through an intermediary</option>
                </select>
              </label>
              <label className="field">
                <span>Matter reference (optional)</span>
                <input className="input mono" value={c.matterReference} onChange={(e) => setC({ ...c, matterReference: e.target.value })} disabled={!!client} />
              </label>
            </div>
            <div className="decide">
              <div className="row" style={{ justifyContent: "flex-end" }}>
                <button className="btn btn-string" onClick={() => create.mutate()} disabled={create.isPending}>
                  {client ? "Continue →" : "Open the file and continue →"}
                </button>
              </div>
            </div>
          </>
        )}
        {step === "people" && (
          <>
            <h1 className="title" style={{ fontSize: 26 }}>
              Who owns or controls {c.kind === "trust" ? "the trust" : c.kind === "partnership" ? "the partnership" : "the company"}?
            </h1>
            <p className="note">Add everyone who holds a share or interest, and everyone who controls it. Kinroot works out who the beneficial owners are.</p>
            <div className="party-cards">
              {parties.map((p) => (
                <div key={p.key} className={`party-card ${p.kind}`}>
                  <div className="pc-head">
                    <span className="pc-kind">{p.kind === "person" ? "○ Person" : p.kind === "trust" ? "◰ Trust" : "■ Company"}</span>
                    {!p.serverId && (
                      <button className="iconbtn" aria-label={`Remove ${p.name || "this party"}`} onClick={() => setParties((ps) => ps.filter((x) => x.key !== p.key))}>
                        <Trash2 />
                      </button>
                    )}
                  </div>
                  <div className="pc-grid">
                    <label className="field">
                      <span>Name</span>
                      <input className="input" value={p.name} onChange={(e) => set(p.key, { name: e.target.value })} onBlur={() => void checkDuplicate(p)} disabled={!!p.serverId} />
                    </label>
                    <label className="field">
                      <span>Role</span>
                      <select className="select" value={p.role} onChange={(e) => set(p.key, { role: e.target.value as Role })} disabled={!!p.serverId}>
                        {ROLES[c.kind].map((r) => (
                          <option key={r} value={r}>
                            {ROLE_LABEL[r]}
                          </option>
                        ))}
                      </select>
                    </label>
                    {HOLDS.includes(p.role) && (
                      <label className="field">
                        <span>Share %</span>
                        <input className="input mono" type="number" min={0} max={100} value={p.pct ?? ""} onChange={(e) => set(p.key, { pct: e.target.value ? Number(e.target.value) : undefined })} disabled={!!p.serverId} />
                      </label>
                    )}
                    {p.kind === "person" && (
                      <label className="field">
                        <span>Date of birth</span>
                        <input className="input" type="date" value={p.birthDate ?? ""} onChange={(e) => set(p.key, { birthDate: e.target.value })} disabled={!!p.serverId} />
                      </label>
                    )}
                    {p.kind === "person" && (
                      <label className="field pc-wide">
                        <span>Residential address</span>
                        <input className="input" value={p.street ?? ""} placeholder="Street" onChange={(e) => set(p.key, { street: e.target.value })} disabled={!!p.serverId} />
                      </label>
                    )}
                    {p.kind === "person" && (
                      <label className="field">
                        <span>Suburb</span>
                        <input className="input" value={p.suburb ?? ""} onChange={(e) => set(p.key, { suburb: e.target.value })} disabled={!!p.serverId} />
                      </label>
                    )}
                    {p.kind === "person" && (
                      <label className="field">
                        <span>Postcode</span>
                        <input className="input mono" inputMode="numeric" maxLength={4} value={p.postcode ?? ""} onChange={(e) => set(p.key, { postcode: e.target.value })} disabled={!!p.serverId} />
                      </label>
                    )}
                  </div>
                  {p.dupOf && (
                    <div className="dup-note">
                      Looks like a person already on file: <b>{p.dupOf.name}</b>.{" "}
                      {p.serverId ? (
                        <button
                          className="link"
                          onClick={async () => {
                            const cand = await api.resolution.propose(p.dupOf!.id, p.serverId!);
                            nav(`/fuse/${cand.id}`);
                          }}
                        >
                          Review the match
                        </button>
                      ) : (
                        <span className="muted">You can review the match once this step is saved.</span>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
            <div className="row" style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
              <button className="btn btn-line" onClick={() => addParty("person")}>
                <Plus /> Add a person
              </button>
              <button className="btn btn-line" onClick={() => addParty("company")}>
                <Plus /> Add a company or trust
              </button>
            </div>
            <p className="note" style={{ marginTop: 14, display: "flex", gap: 6, alignItems: "center" }}>
              <Link2 size={14} aria-hidden /> Coming soon: send the client a secure link to fill in their own owners and documents.
            </p>
            <div className="decide">
              <div className="row" style={{ justifyContent: "space-between" }}>
                <button className="btn btn-quiet" onClick={() => setStep("client")}>
                  Back
                </button>
                <button className="btn btn-string" onClick={() => saveParties.mutate()} disabled={saveParties.isPending || !parties.length}>
                  Continue →
                </button>
              </div>
            </div>
          </>
        )}
        {step === "identity" && (
          <>
            <h1 className="title" style={{ fontSize: 26 }}>
              Check identity
            </h1>
            <p className="note">A document or electronic check for each person and entity. In this sample the check against the issuer is simulated.</p>
            <table className="ledger" style={{ marginTop: 14 }}>
              <tbody>
                {toVerify.map((p) => (
                  <tr key={p.key}>
                    <td className="who">
                      <b>{p.name || "Unnamed"}</b>
                      <small>{p.kind === "person" ? "Passport, driver licence or birth certificate" : "Register extract"}</small>
                    </td>
                    <td className="st" style={{ textAlign: "right" }}>
                      {p.verified ? (
                        <span className="stamp-verified">
                          <BadgeCheck size={14} aria-hidden /> Verified
                        </span>
                      ) : "partial" in p && p.partial ? (
                        <Status tone="review">Partly matched: date of birth or address missing</Status>
                      ) : (
                        <button className="btn btn-line btn-sm" disabled={!p.partyId || verify.isPending} onClick={() => p.partyId && verify.mutate({ key: p.key, partyId: p.partyId })}>
                          Check against the issuer
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="decide">
              <div className="row" style={{ justifyContent: "space-between" }}>
                <button className="btn btn-quiet" onClick={() => setStep("consent")}>
                  Back
                </button>
                <button className="btn btn-string" onClick={() => toReview.mutate()} disabled={toReview.isPending}>
                  Continue →
                </button>
              </div>
            </div>
          </>
        )}
        {step === "consent" && (
          <>
            <h1 className="title" style={{ fontSize: 26 }}>
              Collection notice and consent
            </h1>
            <div className="notice">
              We collect personal information to verify identity and meet our obligations under the AML/CTF Act 2006. We may check it with the document issuer or an electronic verification service. We handle it under the Privacy Act 1988 and keep it for 7 years after our relationship ends. You can ask to see or correct it at any time.
            </div>
            <div style={{ display: "grid", gap: 10, marginTop: 14 }}>
              {c.kind === "individual" && (
                <label className="check">
                  <input type="checkbox" checked={clientConsent} onChange={(e) => setClientConsent(e.target.checked)} />
                  {c.name} has read the notice and consents to the identity check.
                </label>
              )}
              {parties
                .filter((p) => p.kind === "person")
                .map((p) => (
                  <label key={p.key} className="check">
                    <input type="checkbox" checked={!!p.consent} onChange={(e) => set(p.key, { consent: e.target.checked })} />
                    {p.name} has read the notice and consents to the identity check.
                  </label>
                ))}
            </div>
            <div className="decide">
              <div className="row" style={{ justifyContent: "space-between" }}>
                <button className="btn btn-quiet" onClick={() => setStep(c.kind === "individual" ? "client" : "people")}>
                  Back
                </button>
                <button className="btn btn-string" onClick={() => consent.mutate()} disabled={consent.isPending}>
                  Record consent and continue →
                </button>
              </div>
            </div>
          </>
        )}
        {step === "review" && (
          <>
            {!submitted ? (
              <>
                <h1 className="title" style={{ fontSize: 26 }}>
                  Ready to trace
                </h1>
                <p className="note">Kinroot screens everyone, traces the beneficial owners and gives the first rating with its reasons.</p>
                <ul className="checklist">
                  {(checklist?.items ?? []).map((i) => (
                    <li key={i.key}>
                      {i.done ? <Status tone="clear">Done</Status> : <Status tone="review">Open</Status>} {i.label}
                    </li>
                  ))}
                </ul>
                <div className="decide">
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <button className="btn btn-quiet" onClick={() => setStep("identity")}>
                      Back
                    </button>
                    <button className="btn btn-string" onClick={() => submit.mutate()} disabled={submit.isPending}>
                      {submit.isPending ? "Tracing…" : "Create the file and trace"}
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="eyebrow">First rating</div>
                <h1 className="title" style={{ fontSize: 26 }}>
                  {submitted.name}
                </h1>
                <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 8 }}>
                  <RatingTag r={submitted.rating} />
                  {risk.data && <span className="mono">{risk.data.score} / 100</span>}
                </div>
                {risk.data && (
                  <section className="section">
                    <h2>Why</h2>
                    <ReasonList risk={risk.data} structure={structure} onCite={() => undefined} />
                  </section>
                )}
                <div className="decide">
                  <button className="btn btn-ink" onClick={() => nav(`/clients/${submitted.id}/summary`)}>
                    Open the dossier
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </Drawer>
    </>
  );
}
