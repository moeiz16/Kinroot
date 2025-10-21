// Ask the board, chart over record: the question is the masthead, the written answer sits under it with numbered
// citations, and the chart beneath draws only the path the answer used, each cited link numbered and traced in moss.
import { useMutation, useQuery } from "@tanstack/react-query";
import { CornerDownLeft, Copy, Pin } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { errorMessage } from "../api/client";
import { api } from "../api/endpoints";
import type { AssistantAnswer, GraphPayload } from "../api/types";
import { applyPositions, layered } from "../graph/layout";
import type { Scene, StringSpec } from "../graph/model";
import { fromPayload } from "../graph/transforms";
import { useBoard, useBoardScene } from "../shell/board";
import { ChartBand } from "../shell/chart";
import { DecisionBar, Masthead, Page, PageBody, SectionTabs } from "../shell/page";

/** Only the parties and links the answer used, as a structure chart, each cited link numbered. */
export function answerScene(a: AssistantAnswer, graph: GraphPayload | null = a.graph): { scene: Scene; strings: StringSpec[] } | null {
  if (!a.highlight.nodeIds.length || !graph?.nodes.length) return null;
  const model = fromPayload(graph);
  // Level = longest chain of links above the party (clients and other end points at the top).
  const level = new Map(model.nodes.map((n) => [n.id, 0]));
  for (let i = 0; i < model.nodes.length; i++) for (const e of model.edges) level.set(e.s, Math.max(level.get(e.s)!, (level.get(e.t) ?? 0) + 1));
  const cite = new Map(a.citations.map((c, i) => [c.id, i + 1]));
  const nodes = model.nodes.map((n) => ({ ...n, level: level.get(n.id) ?? 0, client: !!n.clientId, sub: n.clientId ? "Client" : n.sub, flags: n.flags.filter((f) => f.level === "high") }));
  const edges = model.edges.map((e) => ({ ...e, cite: cite.get(e.id), label: e.label }));
  const placed = applyPositions(nodes, layered(nodes, edges, { rankSep: 170, nodeSep: 240 }));
  const strings: StringSpec[] = edges.filter((e) => e.cite).map((e) => ({ ids: [e.s, e.t], weight: "full" }));
  return { scene: { key: `ask-${a.id}`, nodes: placed, edges }, strings };
}

/** "Harbour Quay Developments" → "Harbour Quay Developments’", "Bellmere Holdings Ltd" → "Bellmere Holdings Ltd’s". */
export function possessive(name: string): string {
  return /s$/i.test(name) ? `${name}’` : `${name}’s`;
}

export function renderAnswer(text: string, onCite: (n: number) => void): ReactNode[] {
  return text.split(/(\[\d+\])/g).map((part, i) => {
    const m = part.match(/^\[(\d+)\]$/);
    return m ? (
      <button key={i} className="anum" onClick={() => onCite(Number(m[1]))} aria-label={`Citation ${m[1]}`}>
        {m[1]}
      </button>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    );
  });
}

export default function Ask() {
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const board = useBoard();
  const [q, setQ] = useState(params.get("q") ?? "");
  const [answer, setAnswer] = useState<AssistantAnswer | null>(null);
  const [tab, setTab] = useState("links");
  const [copied, setCopied] = useState(false);
  const [pinnedTo, setPinnedTo] = useState<string | null>(null);
  const pin = useMutation({
    mutationFn: ({ answerId, clientId }: { answerId: string; clientId: string; name: string }) => api.assistant.pin(answerId, clientId),
    onSuccess: (_r, v) => setPinnedTo(v.name),
  });
  const suggestions = useQuery({ queryKey: ["suggestions"], queryFn: () => api.assistant.suggestions() });
  const history = useQuery({ queryKey: ["ask-history"], queryFn: () => api.assistant.history() });
  const ask = useMutation({
    mutationFn: (question: string) => api.assistant.ask(question),
    onSuccess: (a) => {
      setAnswer(a);
      setPinnedTo(null);
      setTab("links");
      void history.refetch();
    },
  });
  const started = useRef(false);
  useEffect(() => {
    const initial = params.get("q");
    if (initial && !started.current) {
      started.current = true;
      ask.mutate(initial);
      setParams({}, { replace: true });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const built = useMemo(() => (answer ? answerScene(answer) : null), [answer]);
  useBoardScene(built?.scene ?? null, { unfold: true, strings: built?.strings });

  const onCite = (n: number) => {
    const c = answer?.citations[n - 1];
    const e = built?.scene.edges.find((x) => x.id === c?.id);
    if (!e) return;
    board.engine()?.setDim([e.s, e.t]);
    board.engine()?.flyTo(e.s, 1);
    setTimeout(() => board.engine()?.setDim(null), 2400);
  };
  const submit = (text: string) => {
    if (!text.trim()) return;
    setQ(text);
    ask.mutate(text.trim());
  };
  // The client the question is about: named in the question, else the top of the drawn path.
  const clientNodes = built?.scene.nodes.filter((n) => n.client && n.clientId) ?? [];
  const clientNode = clientNodes.find((n) => answer?.question.toLowerCase().includes(n.label.toLowerCase())) ?? [...clientNodes].sort((x, y) => x.level - y.level)[0];
  const earlier = (history.data ?? []).filter((h) => h.id !== answer?.id);
  const tabs = [
    { id: "links", label: "Links used", count: answer?.citations.length || undefined },
    { id: "edges", label: "How it was found", count: answer?.steps.length || undefined },
    { id: "earlier", label: "Earlier enquiries", count: earlier.length || undefined },
  ];
  const earlierList = (
    <ol className="enquiries">
      {earlier.slice(0, 8).map((h) => (
        <li key={h.id}>
          <button type="button" className="rowbtn" onClick={() => setAnswer(h)}>
            <b>{h.question}</b>
          </button>
          <small>{h.citations.length} links cited</small>
        </li>
      ))}
      {!earlier.length && <li className="muted">Your questions appear here.</li>}
    </ol>
  );

  return (
    <Page skeleton="chart" label="Ask the board" className="ask-page">
      <Masthead
        size={answer ? "name" : "page"}
        refLine={
          <>
            <b>Line of enquiry</b>
            <span className="sep">/</span>
            <span>answers come only from traced ownership and control paths</span>
          </>
        }
        title={answer ? answer.question : "Ask about a person, company or trust"}
      />
      <div className="ask-form">
        <form
          className="ask-field"
          onSubmit={(e) => {
            e.preventDefault();
            submit(q);
          }}
        >
          <label htmlFor="ask-input" className="sr-only">
            Ask about a person, company or trust
          </label>
          <Input id="ask-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask about a person, company or trust…" maxLength={500} autoComplete="off" />
          <Button variant="primary" type="submit" disabled={ask.isPending} aria-label="Ask">
            {ask.isPending ? "Tracing…" : <CornerDownLeft />}
          </Button>
        </form>
        <div className="ask-try">
          <span className="micro">Try</span>
          {(suggestions.data ?? []).slice(0, 3).map((s) => (
            <button key={s} type="button" className="try-chip" onClick={() => submit(s)}>
              {s}
            </button>
          ))}
        </div>
        {ask.isError && <p className="note-error">{errorMessage(ask.error)}</p>}
      </div>
      {answer && (
        <div className="answer-block">
          <span className="micro">Answer</span>
          <p className="answer">{renderAnswer(answer.answer, onCite)}</p>
          {!answer.grounded && <p className="note">Kinroot only answers from traced ownership and control paths.</p>}
        </div>
      )}
      {answer && <ChartBand label="The path the answer used" exhibit="Exhibit" title="The path the answer used" height="mid" legend={["person", "company", "trust", "owns", "controls", "trace"]} />}
      {answer ? (
        <SectionTabs label="Answer" tabs={tabs} active={tab} onTab={setTab} className="record">
          {tab === "links" ? (
            <ol className="cites">
              {answer.citations.map((c, i) => (
                <li key={c.id}>
                  <button className="anum" onClick={() => onCite(i + 1)} aria-label={`Show link ${i + 1} on the board`}>
                    {i + 1}
                  </button>
                  <span>{c.label}</span>
                </li>
              ))}
              {!answer.citations.length && <li className="muted">No links were needed for this answer.</li>}
            </ol>
          ) : tab === "edges" ? (
            <>
              <ol className="timeline">
                {answer.steps.map((s, i) => (
                  <li key={i}>
                    <span className="mono">Step {i + 1}</span>
                    <span>
                      {s.label} <small>· {s.resultCount} found</small>
                    </span>
                  </li>
                ))}
              </ol>
              <p className="note">Answers come only from traced ownership and control paths. If no path exists within 6 steps, Kinroot says so.</p>
            </>
          ) : (
            earlierList
          )}
        </SectionTabs>
      ) : (
        <PageBody>
          <h2 className="title">Earlier enquiries</h2>
          {earlierList}
        </PageBody>
      )}
      {answer && (
        <DecisionBar label="File this answer">
          <div className="row">
            {clientNode?.clientId && answer.grounded && (
              <Button variant="primary" disabled={pin.isPending || pinnedTo === clientNode.label} onClick={() => pin.mutate({ answerId: answer.id, clientId: clientNode.clientId!, name: clientNode.label })}>
                <Pin /> {pinnedTo === clientNode.label ? "Pinned" : `Pin to ${possessive(clientNode.label.replace(/ Pty Ltd$/, ""))} dossier`}
              </Button>
            )}
            {clientNode?.clientId && (
              <Button variant="ink" onClick={() => nav(`/clients/${clientNode.clientId}/timeline`)}>
                Open the dossier
              </Button>
            )}
            <Button
              onClick={() => {
                void navigator.clipboard?.writeText(`${answer.question}\n\n${answer.answer}\n\n${answer.citations.map((c, i) => `[${i + 1}] ${c.label}`).join("\n")}`);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}
            >
              <Copy /> {copied ? "Copied" : "Copy"}
            </Button>
            {pinnedTo && (
              <p role="status" className="note">
                Pinned to {possessive(pinnedTo)} dossier. It sits in the Timeline with the links it cites.
              </p>
            )}
            {pin.isError && <p className="note-error">{errorMessage(pin.error)}</p>}
          </div>
        </DecisionBar>
      )}
    </Page>
  );
}
