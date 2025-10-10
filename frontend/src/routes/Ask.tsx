// Ask the board: questions are lines of enquiry. The answer draws its path on the board in red string with
// numbered citations, and the drawer holds the written answer with the same numbers.
import { useMutation, useQuery } from "@tanstack/react-query";
import { CornerDownLeft, Copy, Pin } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { errorMessage } from "../api/client";
import { api } from "../api/endpoints";
import type { AssistantAnswer, GraphPayload } from "../api/types";
import { applyPositions, layered } from "../graph/layout";
import type { Scene, StringSpec } from "../graph/model";
import { fromPayload } from "../graph/transforms";
import { useBoard, useBoardScene } from "../shell/board";
import { BoardTools } from "../shell/chrome";
import { Drawer } from "../shell/Drawer";
import "./sheets.css";
import "./ask.css";

/** Only the parties and links the answer used, laid out roots-down, each cited link numbered. */
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
  const [tab, setTab] = useState("answer");
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
      setTab("answer");
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
  // Keep the drawing clear of the question slip at the bottom of the board.
  useEffect(() => {
    board.setReserve({ bottom: 90 });
    return () => board.setReserve({ bottom: 0 });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <div className="chrome queue-tray" style={{ top: 16, left: 16, right: board.occlusion.right + 16 }}>
        <div className="tray" role="list" aria-label="Earlier enquiries">
          <span className="cap">Enquiries</span>
          {(history.data ?? []).slice(0, 4).map((h) => (
            <button key={h.id} className="slip" role="listitem" aria-current={answer?.id === h.id} onClick={() => setAnswer(h)}>
              <b>{h.question}</b>
              <small>{h.citations.length} links cited</small>
            </button>
          ))}
          {!history.data?.length && <span className="muted" style={{ alignSelf: "center", fontSize: 12.5 }}>Your questions appear here.</span>}
        </div>
      </div>
      <BoardTools minimap={false} />
      <div className="chrome ask-slip" style={{ bottom: board.occlusion.bottom + 20, left: `calc(${board.occlusion.left}px + (100% - ${board.occlusion.left + board.occlusion.right}px) / 2)` }}>
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
          <input id="ask-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask about a person, company or trust…" maxLength={500} autoComplete="off" />
          <button className="btn btn-string btn-sm" type="submit" disabled={ask.isPending} aria-label="Ask">
            {ask.isPending ? "Tracing…" : <CornerDownLeft />}
          </button>
        </form>
        <div className="ask-try">
          <span>Try:</span>
          {(suggestions.data ?? []).slice(0, 3).map((s) => (
            <button key={s} className="chip" onClick={() => submit(s)}>
              {s}
            </button>
          ))}
        </div>
        {ask.isError && <p className="note-error">{errorMessage(ask.error)}</p>}
      </div>
      {answer && (
        <Drawer label="Answer" tabs={[{ id: "answer", label: "Answer" }, { id: "edges", label: "Links used", count: answer.citations.length }]} active={tab} onTab={setTab} onClose={() => setAnswer(null)}>
          {tab === "answer" ? (
            <>
              <div className="eyebrow">Line of enquiry</div>
              <h1 className="title" style={{ fontSize: 26 }}>
                {answer.question}
              </h1>
              <p className="answer">{renderAnswer(answer.answer, onCite)}</p>
              {!answer.grounded && <p className="note">Kinroot only answers from traced ownership and control paths.</p>}
              {answer.citations.length > 0 && (
                <section className="section">
                  <h2>Links used</h2>
                  <ol className="cites">
                    {answer.citations.map((c, i) => (
                      <li key={c.id}>
                        <button className="anum" onClick={() => onCite(i + 1)} aria-label={`Show link ${i + 1} on the board`}>
                          {i + 1}
                        </button>
                        <span>{c.label}</span>
                      </li>
                    ))}
                  </ol>
                </section>
              )}
              <div className="decide">
                <div className="row">
                  {clientNode?.clientId && answer.grounded && (
                    <button
                      className="btn btn-string"
                      disabled={pin.isPending || pinnedTo === clientNode.label}
                      onClick={() => pin.mutate({ answerId: answer.id, clientId: clientNode.clientId!, name: clientNode.label })}
                    >
                      <Pin /> {pinnedTo === clientNode.label ? "Pinned" : `Pin to ${clientNode.label.replace(/ Pty Ltd$/, "")}’s dossier`}
                    </button>
                  )}
                  {clientNode?.clientId && (
                    <button className="btn btn-ink" onClick={() => nav(`/clients/${clientNode.clientId}/timeline`)}>
                      Open the dossier
                    </button>
                  )}
                  <button
                    className="btn btn-line"
                    onClick={() => {
                      void navigator.clipboard?.writeText(`${answer.question}\n\n${answer.answer}\n\n${answer.citations.map((c, i) => `[${i + 1}] ${c.label}`).join("\n")}`);
                      setCopied(true);
                      setTimeout(() => setCopied(false), 2000);
                    }}
                  >
                    <Copy /> {copied ? "Copied" : "Copy"}
                  </button>
                </div>
              </div>
              {pinnedTo && (
                <p role="status" className="note" style={{ marginTop: 10 }}>
                  Pinned to {pinnedTo}’s dossier. It sits in the Timeline with the links it cites.
                </p>
              )}
              {pin.isError && <p className="note-error">{errorMessage(pin.error)}</p>}
            </>
          ) : (
            <>
              <h1 className="title" style={{ fontSize: 24 }}>
                How Kinroot found this
              </h1>
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
              <p className="note" style={{ marginTop: 14 }}>
                Answers come only from traced ownership and control paths. If no path exists within 6 steps, Kinroot says so.
              </p>
            </>
          )}
        </Drawer>
      )}
    </>
  );
}
