// New client: a short form in five steps beside the chart, which builds the structure live as owners are added
// (each new party rises above the client). Back and Continue sit in the bar at the foot.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BadgeCheck, Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody } from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ApiError, errorMessage } from "../api/client";
import { api } from "../api/endpoints";
import type { Client, ClientKind, Onboarding, Service } from "../api/types";
import { applyPositions, layered } from "../graph/layout";
import type { BEdge, BKind, BNode, Scene } from "../graph/model";
import { initials } from "../graph/transforms";
import { today } from "../lib/dates";
import { KIND_LABEL, SERVICE_LABEL } from "../lib/format";
import { useBoardHandlers, useBoardScene } from "../shell/board";
import { ChartBand, KindGlyph, RatingTag, Status } from "../shell/chart";
import { DecisionBar, Page, PageHeader, SectionTabs, useTitle } from "../shell/page";
import { ReasonList } from "./dossier/panels";
import { useStructure } from "./dossier/structure";

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

/** The structure as it is being typed: the client at the foot, every added party rising above it. */
/** Draft party keys: a counter, never the clock (two parties added in the same millisecond must not collide). */
let draftSeq = 0;

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
  if (canAdd) nodes.push({ id: "ghost", kind: "unknown", label: "+ Add owner", glyph: "+", level: 1, from: "client", flags: [], aria: "Add an owner or controller", x: 0, y: 0 });
  // The key carries the draft's content: the board redraws as people are added, renamed or given a share.
  const key = `onboard-draft:${c.kind}:${c.name}:${parties.map((p) => `${p.kind}/${p.name}/${p.role}/${p.pct ?? ""}`).join("|")}:${canAdd ? 1 : 0}`;
  return { key, nodes: applyPositions(nodes, layered(nodes, edges, { nodeSep: 215 })), edges };
}

// Consent comes before the identity check: the collection notice is given, and consent to an electronic check
// recorded, before anyone's details are checked against an issuer (Privacy Act 1988; AML/CTF Rules safe harbour).
const STEPS = [
  { id: "client", label: "Client" },
  { id: "people", label: "Owners" },
  { id: "consent", label: "Consent" },
  { id: "identity", label: "Identity" },
  { id: "review", label: "Review" },
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
  const addParty = (kind: DraftParty["kind"]) => setParties((ps) => [...ps, { key: `d${++draftSeq}`, kind, name: "", role: ROLES[c.kind][0] ?? "owner" }]);
  useBoardHandlers({ onActivate: (id) => id === "ghost" && addParty("person") });
  const set = (k: string, patch: Partial<DraftParty>) => setParties((ps) => ps.map((p) => (p.key === k ? { ...p, ...patch } : p)));
  useTitle("New client");

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
    <Page label="New client" className="onboard">
      <PageHeader back={{ to: "/clients", label: "Clients" }} title={c.name || "New client"} status={client ? <Status tone="review">Draft</Status> : undefined} />
      <div className="onboard-grid">
      <SectionTabs label="New client" tabs={STEPS} active={step} onTab={(s) => (client || s === "client" ? setStep(s) : undefined)} className="steps">
        {err && (
          <p className="note-error" role="alert" style={{ marginBottom: 14 }}>
            {err}
          </p>
        )}
        {step === "client" && (
          <>
            <ToggleGroup type="single" aria-label="Client type" className="kind-pick" value={c.kind} onValueChange={(k) => k && !client && setC({ ...c, kind: k as ClientKind })}>
              {(Object.keys(KIND_LABEL) as ClientKind[]).map((k) => (
                <ToggleGroupItem key={k} value={k} disabled={!!client && c.kind !== k}>
                  {KIND_LABEL[k]}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <div style={{ display: "grid", gap: 14, marginTop: 16 }}>
              <label className="field">
                <span>{c.kind === "individual" ? "Full name" : "Legal name"}</span>
                <Input value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} disabled={!!client} />
              </label>
              {c.kind === "individual" ? (
                <>
                  <label className="field">
                    <span>Date of birth</span>
                    <Input type="date" value={c.birthDate} onChange={(e) => setC({ ...c, birthDate: e.target.value })} disabled={!!client} />
                  </label>
                  <label className="field">
                    <span>Residential address</span>
                    <Input value={c.street} placeholder="Street" onChange={(e) => setC({ ...c, street: e.target.value })} disabled={!!client} />
                  </label>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 120px", gap: 10 }}>
                    <label className="field">
                      <span>Suburb</span>
                      <Input value={c.suburb} onChange={(e) => setC({ ...c, suburb: e.target.value })} disabled={!!client} />
                    </label>
                    <label className="field">
                      <span>Postcode</span>
                      <Input className="mono" inputMode="numeric" maxLength={4} value={c.postcode} onChange={(e) => setC({ ...c, postcode: e.target.value })} disabled={!!client} />
                    </label>
                  </div>
                </>
              ) : (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 120px", gap: 10 }}>
                  <label className="field">
                    <span>{c.kind === "company" ? "ACN" : "ABN"}</span>
                    <Input className="mono" value={c.identifier} onChange={(e) => setC({ ...c, identifier: e.target.value })} disabled={!!client} />
                  </label>
                  <label className="field">
                    <span>State</span>
                    <Select value={c.state} onValueChange={(v) => setC({ ...c, state: v })} disabled={!!client}>
                      <SelectTrigger aria-label="State" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {["NSW", "VIC", "QLD", "WA", "SA", "TAS", "ACT", "NT"].map((s) => (
                          <SelectItem key={s} value={s}>
                            {s}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </label>
                </div>
              )}
              <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
                <legend className="legend-label">Services</legend>
                <div className="svc-grid">
                  {(["property_transaction", "conveyancing", "managing_client_funds", "company_formation", "trust_formation", "tax_advice"] as Service[]).map((s) => (
                    <label key={s} className="check">
                      <Checkbox checked={c.services.includes(s)} disabled={!!client} onCheckedChange={() => setC({ ...c, services: c.services.includes(s) ? c.services.filter((x) => x !== s) : [...c.services, s] })} />
                      {SERVICE_LABEL[s]}
                    </label>
                  ))}
                </div>
              </fieldset>
              <label className="field">
                <span>How you met them</span>
                <Select value={c.channel} onValueChange={(v) => setC({ ...c, channel: v as Client["channel"] })} disabled={!!client}>
                  <SelectTrigger aria-label="How you met them" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="face_to_face">In person</SelectItem>
                    <SelectItem value="remote">Remotely</SelectItem>
                    <SelectItem value="intermediary">Through an intermediary</SelectItem>
                  </SelectContent>
                </Select>
              </label>
              <label className="field">
                <span>Matter reference (optional)</span>
                <Input className="mono" value={c.matterReference} onChange={(e) => setC({ ...c, matterReference: e.target.value })} disabled={!!client} />
              </label>
            </div>
          </>
        )}
        {step === "people" && (
          <>
            <div className="party-cards">
              {parties.map((p) => (
                <div key={p.key} className={`party-card ${p.kind}`}>
                  <div className="pc-head">
                    <span className="pc-kind">
                      <KindGlyph kind={p.kind} size={13} />
                      {p.kind === "person" ? "Person" : p.kind === "trust" ? "Trust" : "Company"}
                    </span>
                    {!p.serverId && (
                      <Button variant="quiet" size="icon" aria-label={`Remove ${p.name || "this party"}`} onClick={() => setParties((ps) => ps.filter((x) => x.key !== p.key))}>
                        <Trash2 />
                      </Button>
                    )}
                  </div>
                  <div className="pc-grid">
                    <label className="field">
                      <span>Name</span>
                      <Input value={p.name} onChange={(e) => set(p.key, { name: e.target.value })} onBlur={() => void checkDuplicate(p)} disabled={!!p.serverId} />
                    </label>
                    <label className="field">
                      <span>Role</span>
                      <Select value={p.role} onValueChange={(v) => set(p.key, { role: v as Role })} disabled={!!p.serverId}>
                        <SelectTrigger aria-label="Role" className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {ROLES[c.kind].map((r) => (
                            <SelectItem key={r} value={r}>
                              {ROLE_LABEL[r]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </label>
                    {HOLDS.includes(p.role) && (
                      <label className="field">
                        <span>Share %</span>
                        <Input className="mono" type="number" min={0} max={100} value={p.pct ?? ""} onChange={(e) => set(p.key, { pct: e.target.value ? Number(e.target.value) : undefined })} disabled={!!p.serverId} />
                      </label>
                    )}
                    {p.kind === "person" && (
                      <label className="field">
                        <span>Date of birth</span>
                        <Input type="date" value={p.birthDate ?? ""} onChange={(e) => set(p.key, { birthDate: e.target.value })} disabled={!!p.serverId} />
                      </label>
                    )}
                    {p.kind === "person" && (
                      <label className="field pc-wide">
                        <span>Residential address</span>
                        <Input value={p.street ?? ""} placeholder="Street" onChange={(e) => set(p.key, { street: e.target.value })} disabled={!!p.serverId} />
                      </label>
                    )}
                    {p.kind === "person" && (
                      <label className="field">
                        <span>Suburb</span>
                        <Input value={p.suburb ?? ""} onChange={(e) => set(p.key, { suburb: e.target.value })} disabled={!!p.serverId} />
                      </label>
                    )}
                    {p.kind === "person" && (
                      <label className="field">
                        <span>Postcode</span>
                        <Input className="mono" inputMode="numeric" maxLength={4} value={p.postcode ?? ""} onChange={(e) => set(p.key, { postcode: e.target.value })} disabled={!!p.serverId} />
                      </label>
                    )}
                  </div>
                  {p.dupOf && (
                    <div className="dup-note">
                      Already on file? <b>{p.dupOf.name}</b>{" "}
                      {p.serverId ? (
                        <Button
                          variant="link"
                          onClick={async () => {
                            const cand = await api.resolution.propose(p.dupOf!.id, p.serverId!);
                            nav(`/fuse/${cand.id}`);
                          }}
                        >
                          Review the match
                        </Button>
                      ) : (
                        <span className="muted">Review after saving</span>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
            <div className="row" style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
              <Button onClick={() => addParty("person")}>
                <Plus /> Add a person
              </Button>
              <Button onClick={() => addParty("company")}>
                <Plus /> Add a company
              </Button>
            </div>
          </>
        )}
        {step === "identity" && (
          <>
            <Table>
              <TableBody>
                {toVerify.map((p) => (
                  <tr key={p.key}>
                    <td className="who">
                      <b>{p.name || "Unnamed"}</b>
                      <small>{p.kind === "person" ? "ID document" : "Register extract"}</small>
                    </td>
                    <td className="st" style={{ textAlign: "right" }}>
                      {p.verified ? (
                        <span className="stamp-verified">
                          <BadgeCheck size={14} aria-hidden /> Verified
                        </span>
                      ) : "partial" in p && p.partial ? (
                        <span title="Date of birth or address missing">
                          <Status tone="review">Partly matched</Status>
                        </span>
                      ) : (
                        <Button size="sm" disabled={!p.partyId || verify.isPending} onClick={() => p.partyId && verify.mutate({ key: p.key, partyId: p.partyId })}>
                          Check
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </TableBody>
            </Table>
          </>
        )}
        {step === "consent" && (
          <>
            <details className="notice">
              <summary>Collection notice</summary>
              We collect personal information to verify identity and meet our obligations under the AML/CTF Act 2006. We may check it with the document issuer or an electronic verification service. We handle it under the Privacy Act 1988 and keep it for 7 years after our relationship ends. You can ask to see or correct it at any time.
            </details>
            <div style={{ display: "grid", gap: 10, marginTop: 14 }}>
              {c.kind === "individual" && (
                <label className="check">
                  <Checkbox checked={clientConsent} onCheckedChange={(v) => setClientConsent(v === true)} />
                  {c.name} consents
                </label>
              )}
              {parties
                .filter((p) => p.kind === "person")
                .map((p) => (
                  <label key={p.key} className="check">
                    <Checkbox checked={!!p.consent} onCheckedChange={(v) => set(p.key, { consent: v === true })} />
                    {p.name} consents
                  </label>
                ))}
            </div>
          </>
        )}
        {step === "review" && (
          <>
            {!submitted ? (
              <>
                <ul className="checklist">
                  {(checklist?.items ?? []).map((i) => (
                    <li key={i.key}>
                      {i.done ? <Status tone="clear">Done</Status> : <Status tone="review">Open</Status>} {i.label}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <>
                <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  <RatingTag r={submitted.rating} />
                  {risk.data && <span className="note">{risk.data.score} / 100</span>}
                </div>
                {risk.data && (
                  <section className="section">
                    <h2>Reasons</h2>
                    <ReasonList risk={risk.data} structure={structure} onCite={() => undefined} />
                  </section>
                )}
              </>
            )}
          </>
        )}
      </SectionTabs>
      <div className="onboard-chart">
        <ChartBand label="The structure as you enter it" height="mid" legend={["person", "company", "trust", "owns", "controls"]} />
      </div>
      </div>
      <DecisionBar label="Next step">
        <div className="row" style={{ justifyContent: step === "client" ? "flex-end" : "space-between" }}>
          {step === "client" && (
            <Button variant="primary" onClick={() => create.mutate()} disabled={create.isPending}>
              Continue
            </Button>
          )}
          {step === "people" && (
            <>
              <Button variant="quiet" onClick={() => setStep("client")}>
                Back
              </Button>
              <Button variant="primary" onClick={() => saveParties.mutate()} disabled={saveParties.isPending || !parties.length}>
                Continue
              </Button>
            </>
          )}
          {step === "consent" && (
            <>
              <Button variant="quiet" onClick={() => setStep(c.kind === "individual" ? "client" : "people")}>
                Back
              </Button>
              <Button variant="primary" onClick={() => consent.mutate()} disabled={consent.isPending}>
                Continue →
              </Button>
            </>
          )}
          {step === "identity" && (
            <>
              <Button variant="quiet" onClick={() => setStep("consent")}>
                Back
              </Button>
              <Button variant="primary" onClick={() => toReview.mutate()} disabled={toReview.isPending}>
                Continue
              </Button>
            </>
          )}
          {step === "review" &&
            (!submitted ? (
              <>
                <Button variant="quiet" onClick={() => setStep("identity")}>
                  Back
                </Button>
                <Button variant="primary" onClick={() => submit.mutate()} disabled={submit.isPending}>
                  {submit.isPending ? "Tracing…" : "Create and trace"}
                </Button>
              </>
            ) : (
              <Button variant="primary" onClick={() => nav(`/clients/${submitted.id}/summary`)}>
                Open the file
              </Button>
            ))}
        </div>
      </DecisionBar>
    </Page>
  );
}
