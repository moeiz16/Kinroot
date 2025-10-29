// The party drawer: what you see when you click someone on the chart. Who they are, how they connect to the
// client (the path, with the working of the share), and where their checks stand. Everything the chart leaves out.
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import type { DocumentRec, ScreeningHit, VerificationCheck } from "../../api/types";
import { KindGlyph, Status } from "../../shell/chart";
import type { Structure } from "./structure";

const KIND_WORD: Record<string, string> = { person: "Person", company: "Company", trust: "Trust", partnership: "Partnership", unknown: "Not yet known", stack: "Group of companies", list: "List entry", address: "Address" };

/** Identity is verified by an electronic or document check, or by an identity document on file. */
export function hasId(docs: DocumentRec[], partyId: string, checks: VerificationCheck[] = []): boolean {
  return checks.some((c) => c.partyId === partyId && c.result === "verified") || docs.some((d) => d.partyId === partyId && ["passport", "drivers_licence", "birth_certificate", "company_extract", "trust_deed"].includes(d.docType));
}

const fmtPct = (n: number) => `${Math.round(n * 10) / 10}%`;

export function PartyDrawer({ partyId, structure, clientId, docs, checks, hits, onClose }: { partyId: string | null; structure: Structure | null; clientId: string; docs: DocumentRec[]; checks: VerificationCheck[]; hits: ScreeningHit[]; onClose: () => void }) {
  const n = partyId ? structure?.nodes.find((x) => x.id === partyId) : undefined;
  const owner = partyId ? structure?.ubo?.owners.find((o) => o.partyId === partyId) : undefined;
  const path = owner?.paths.find((p) => p.effectivePct != null) ?? owner?.paths[0];
  const pcts = path
    ? path.nodeIds.slice(0, -1).map((id, i) => {
        const next = path.nodeIds[i + 1]!;
        const e = structure?.edges.find((x) => x.s === id && x.t === next);
        return e?.pct ?? (e?.label?.match(/^(\d+(?:\.\d+)?)%$/) ? Number(e.label.slice(0, -1)) : null);
      })
    : [];
  const links = n ? (structure?.edges ?? []).filter((e) => e.s === n.id && !e.removed) : [];
  const hit = n ? hits.find((h) => h.partyId === n.id && h.status !== "false_positive") : undefined;
  const checkable = n && ["person", "company", "trust", "partnership"].includes(n.kind);
  return (
    <Sheet open={!!n} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full gap-0 sm:max-w-[400px]" onOpenAutoFocus={(e) => e.preventDefault()}>
        {n && (
          <>
            <SheetHeader className="px-5 pt-5 pb-4">
              <SheetTitle className="flex items-center gap-2 pr-6">
                <KindGlyph kind={n.kind} size={16} />
                {n.label}
              </SheetTitle>
              <SheetDescription>{n.client ? "This client" : (KIND_WORD[n.kind] ?? "Party")}</SheetDescription>
            </SheetHeader>
            <div className="drawer-body">
              {(owner?.isUbo || hit || checkable) && (
                <div className="flex flex-wrap gap-2">
                  {owner?.isUbo && <Status tone="neutral">Beneficial owner</Status>}
                  {checkable && (hasId(docs, n.id, checks) ? <Status tone="clear">ID verified</Status> : <Status tone="review">Ask client for ID</Status>)}
                  {hit && <Status tone={hit.status === "true_match" ? "high" : "review"}>{hit.status === "pending" ? "Possible match" : hit.status === "true_match" ? "Confirmed match" : "Escalated"}</Status>}
                  {n.pep && <Status tone="review">Politically exposed</Status>}
                </div>
              )}
              <dl className="facts">
                {n.sub && !owner && !links.length && (
                  <>
                    <dt>Details</dt>
                    <dd>{n.sub}</dd>
                  </>
                )}
                {owner?.effectivePct != null && (
                  <>
                    <dt>Owns</dt>
                    <dd>
                      <b>{fmtPct(owner.effectivePct)}</b>
                      {pcts.length > 1 && pcts.every((p) => p != null) && <span className="muted"> · {pcts.map((p) => fmtPct(p!)).join(" × ")}</span>}
                    </dd>
                  </>
                )}
                {owner && owner.controlRoles.length > 0 && (
                  <>
                    <dt>Controls as</dt>
                    <dd>{owner.controlRoles.join(", ").toLowerCase()}</dd>
                  </>
                )}
                {!owner &&
                  links.slice(0, 3).map((e) => (
                    <div key={e.id} style={{ display: "contents" }}>
                      <dt>{e.kind === "own" ? "Owns" : e.kind === "unknown" ? "Holds" : "Role"}</dt>
                      <dd>
                        {e.kind === "ctrl" ? `${e.label ?? "Controls"} of ` : `${e.label ?? ""} of `}
                        {structure?.names(e.t)}
                      </dd>
                    </div>
                  ))}
              </dl>
              {path && path.nodeIds.length > 1 && (
                <section>
                  <h3 className="title" style={{ fontSize: 14 }}>
                    Path to the client
                  </h3>
                  <ol className="path">
                    {path.nodeIds.map((id, i) => (
                      <li key={id} className={i === path.nodeIds.length - 1 ? "end" : undefined}>
                        {structure?.names(id)}
                        {i < pcts.length && pcts[i] != null && <small>owns {fmtPct(pcts[i]!)}</small>}
                      </li>
                    ))}
                  </ol>
                </section>
              )}
              {n.flags.length > 0 && (
                <ul className="flag-list">
                  {n.flags.map((f) => (
                    <li key={f.text} className={f.level}>
                      <span className="dot" aria-hidden />
                      {f.text.replace(/^[▲◆●]\s*/, "")}
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex flex-wrap gap-2">
                {hit?.status === "pending" && (
                  <Button asChild variant="primary" size="sm">
                    <Link to={`/screening/${hit.id}`}>Review the match</Link>
                  </Button>
                )}
                {n.clientId && n.clientId !== clientId && (
                  <Button asChild variant="line" size="sm">
                    <Link to={`/clients/${n.clientId}/summary`}>Open their file</Link>
                  </Button>
                )}
              </div>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
