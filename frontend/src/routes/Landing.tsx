// Public landing: the board itself is the hero. Type a client's name into the client pin, watch its owners
// unfold beneath it, then the red string is pulled taut to the real owner and the reasons slip pins itself.
import { FolderTree, RefreshCcw, Spline, Users } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { BoardEngine, webglAvailable } from "../graph/engine";
import { DEMO_PASSWORD, useAuth } from "../lib/auth";
import { tranche2Line } from "../lib/dates";
import { prefersReduced } from "../lib/theme";
import { PHONE, useMedia } from "../lib/useMedia";
import { Logo } from "../shell/chrome";
import { SCENARIOS, type Scenario } from "./landing/scenarios";
import "./landing/landing.css";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const CHIP_ICON = { trust: <FolderTree />, circle: <RefreshCcw />, nominee: <Users /> } as Record<string, React.ReactNode>;

export default function Landing() {
  const host = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLDivElement>(null);
  const engine = useRef<BoardEngine | null>(null);
  const runId = useRef(0);
  const phone = useMedia(PHONE);
  const reduced = prefersReduced();
  const [scenario, setScenario] = useState<Scenario>(SCENARIOS[0]!);
  const [typed, setTyped] = useState("");
  const [phase, setPhase] = useState<"pre" | "typing" | "tracing" | "done">("pre");
  const [canDraw] = useState(() => webglAvailable());
  const [opening, setOpening] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const nav = useNavigate();
  const { signIn } = useAuth();

  const placeField = useCallback(() => {
    const p = engine.current?.nodeViewport("c");
    if (p && field.current) field.current.style.transform = `translate(${p.x}px, ${p.y}px)`;
  }, []);

  useEffect(() => {
    if (!host.current || !canDraw) return;
    const e = new BoardEngine(host.current, { reduced, onSync: placeField, pad: { x: 340, y: 200 }, ariaLabel: "Sample ownership structure" });
    engine.current = e;
    const ro = new ResizeObserver(() => e.resize());
    ro.observe(host.current);
    return () => {
      ro.disconnect();
      e.destroy();
      engine.current = null;
    };
  }, [canDraw, reduced, placeField]);

  useEffect(() => {
    engine.current?.setInsets(phone ? { top: 170, left: 4, right: 4, bottom: 30 } : { top: 150, left: 500, right: 40, bottom: 70 });
  }, [phone, canDraw]);

  const run = useCallback(
    async (s: Scenario, name?: string) => {
      const id = ++runId.current;
      const e = engine.current;
      setScenario(s);
      setPhase("typing");
      const label = name ?? s.name;
      if (!e) {
        setTyped(label);
        setPhase("done");
        return;
      }
      await e.setScene({ key: `${s.id}-${id}`, nodes: s.nodes.map((n) => ({ ...n })), edges: s.edges }, { hold: true });
      placeField();
      if (!reduced && !name) {
        setTyped("");
        await wait(500);
        for (let i = 1; i <= label.length; i++) {
          if (runId.current !== id) return;
          setTyped(label.slice(0, i));
          await wait(38);
        }
        await wait(260);
      } else setTyped(label);
      if (runId.current !== id) return;
      setPhase("tracing");
      await e.unfoldAll();
      await wait(reduced ? 0 : 220);
      if (runId.current !== id) return;
      await e.pull([s.string], { animate: !reduced });
      if (s.ownerSub) e.setNodeSub(s.ownerSub.id, s.ownerSub.text);
      if (runId.current === id) setPhase("done");
    },
    [placeField, reduced],
  );

  useEffect(() => {
    if (!canDraw) {
      setTyped(SCENARIOS[0]!.name);
      setPhase("done");
      return;
    }
    let live = true;
    void document.fonts.ready.then(() => {
      if (live) void run(SCENARIOS[0]!);
    });
    return () => {
      live = false;
      // eslint-disable-next-line react-hooks/exhaustive-deps -- cancels the running trace, by design
      runId.current++;
    };
  }, [run, canDraw]);

  const submit = () => {
    const name = (input.current?.value ?? typed).trim();
    if (!name) return;
    const match = SCENARIOS.find((s) => s.name.toLowerCase().startsWith(name.toLowerCase()));
    void run(match ?? SCENARIOS[0]!, match ? match.name : name);
  };

  const openFiles = async () => {
    setOpening(true);
    try {
      await signIn("daniel@harbourline.example", DEMO_PASSWORD);
      nav("/board");
    } catch {
      nav("/sign-in?demo=1");
    }
  };

  const look = scenario.slip.look;
  return (
    <div className="landing">
      <header className="top">
        <Link className="brand" to="/" aria-label="Kinroot home">
          <Logo />
          <span className="wm">Kinroot</span>
        </Link>
        <nav className="nav" aria-label="Main">
          <a href="#who">Who it is for</a>
          <a href="#regimes">Tranche 2 and the UK MLR</a>
          <a href="#safe">How we keep files safe</a>
          <Link to="/sign-in" className="signin">
            Sign in
          </Link>
        </nav>
      </header>

      <main>
        <section className={`hero ${phase}`} aria-label="Trace a client">
          <div ref={host} className="board" aria-hidden={!canDraw} />

          <div ref={field} className="typein">
            <form
              className="pinfield"
              role="search"
              onSubmit={(e) => {
                e.preventDefault();
                submit();
              }}
            >
              <label className="lead" htmlFor="client-name">
                Client
              </label>
              <input
                ref={input}
                id="client-name"
                className="val"
                value={typed}
                placeholder="Type a client's name"
                autoComplete="off"
                onChange={(e) => {
                  runId.current++;
                  setTyped(e.target.value);
                  setPhase("pre");
                }}
              />
              {phase === "typing" && <span className="caret" aria-hidden />}
              <Button variant="string" size="sm" className="go" type="submit" aria-label="Trace this client">
                Trace
              </Button>
            </form>
            <div className="chips" style={{ opacity: phase === "pre" || phase === "typing" ? 1 : phase === "done" ? 1 : 0 }}>
              <span>Or try</span>
              {SCENARIOS.filter((s) => s.chip).map((s) => (
                <Button key={s.id} size="sm" className="chip" type="button" aria-pressed={scenario.id === s.id} onClick={() => void run(s)}>
                  {CHIP_ICON[s.id]}
                  {s.chip}
                </Button>
              ))}
            </div>
          </div>

          <aside className={`slip-note landing-slip${phase === "done" ? " on" : ""}`} aria-live="polite" aria-hidden={phase !== "done"}>
            <div className="eyebrow">
              <span className={`status ${look}`}>
                <span className="g" aria-hidden>
                  {look === "high" ? "▲" : "◆"}
                </span>
                {look === "high" ? "High" : "Review"}
              </span>
              {scenario.slip.lead}
            </div>
            <h2>{scenario.slip.title}</h2>
            <ol>
              {scenario.slip.reasons.map((r) => (
                <li key={r.n}>
                  <span className="n">{r.n}</span>
                  <span>{r.text}</span>
                </li>
              ))}
            </ol>
            <div className="foot">
              <p>{scenario.slip.next}</p>
              <Button variant="link" onClick={openFiles}>
                Open dossier →
              </Button>
            </div>
          </aside>

          <div className="caption">
            <div className="eyebrow">Client due diligence for law firms, accountants and conveyancers</div>
            <h1>
              See who is <em>really</em> behind your client.
            </h1>
            <p>Type a client’s name. Kinroot follows every shareholding, trust and directorship to the people at the end of them, then tells you what to check before you act.</p>
            <div className="cta">
              <Button
                variant="string"
                onClick={() => {
                  input.current?.focus();
                  void run(scenario);
                }}
              >
                <Spline />
                Trace a client
              </Button>
              <Button variant="link" onClick={openFiles} disabled={opening}>
                {opening ? "Opening…" : "Open Harbourline’s files →"}
              </Button>
            </div>
            <div className="fine">
              <span>
                Designed to support the AML/CTF Act 2006 and the UK Money Laundering Regulations 2017. <span>{tranche2Line()}</span>
              </span>
            </div>
          </div>
          <div className="sample">Sample structure · not a real company</div>
        </section>

        <section className="notes" id="who">
          <div className="notes-head">
            <span className="notes-no">Part 1</span>
            <h2>Three people sign off on a client. Each sees the part they need.</h2>
          </div>
          <ol className="judgment">
            <li>
              <h3>Fee earners open a matter without a week of forms.</h3>
              <p>Send the client one link. Identity checks, ownership and consent arrive in the file, already traced to the people behind it.</p>
            </li>
            <li>
              <h3>Compliance officers sign off with the reasons in front of them.</h3>
              <p>Every rating comes with the sentences behind it, each citing the link it rests on. Enhanced checks are triggered for you, and nothing proceeds until you sign.</p>
            </li>
            <li>
              <h3>Partners know the firm’s exposure on one page.</h3>
              <p>Overdue reviews, high-risk clients and open screening matches, in plain words, ready for the next partners’ meeting.</p>
            </li>
          </ol>
        </section>

        <section className="notes regimes" id="regimes">
          <div className="notes-head">
            <span className="notes-no">Part 2</span>
            <h2>Built for Tranche 2 and the UK MLR 2017.</h2>
          </div>
          <p className="sub">Obligation by obligation, this is where Kinroot does the work. It is designed to support your AML/CTF programme; your firm stays responsible for it.</p>
          <Table className="obligations">
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Obligation</TableHead>
                <TableHead scope="col">Australia: AML/CTF Act 2006</TableHead>
                <TableHead scope="col">United Kingdom: MLR 2017</TableHead>
                <TableHead scope="col">In Kinroot</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {[
                ["Know who you act for", "Customer due diligence before providing a designated service", "Regulation 28 customer due diligence", "Onboarding with identity checks, consent and the client link"],
                ["Find the real owners", "Beneficial owners at 25% or control", "Beneficial owners over 25% or control", "Pull the thread: compounded ownership through every layer"],
                ["Check the lists", "Sanctions and politically exposed persons", "Sanctions, PEPs and family members", "Screening with match likelihood and a reasoned decision"],
                ["Look harder when it matters", "Enhanced due diligence for higher risk", "Regulation 33 enhanced due diligence", "Triggers, measures and two-stage sign-off"],
                ["Keep watching", "Ongoing customer due diligence", "Ongoing monitoring", "Alerts when owners, officers or lists change"],
                ["Report suspicion", "Suspicious matter reports within 3 business days", "Suspicious activity reports to the NCA", "Restricted case files and a draft ready for you to lodge"],
                ["Keep the records", "7 years", "5 years", "A sealed activity log and a retention schedule"],
              ].map((r) => (
                <tr key={r[0]}>
                  <td className="who">
                    <b>{r[0]}</b>
                  </td>
                  <td>{r[1]}</td>
                  <td>{r[2]}</td>
                  <td>{r[3]}</td>
                </tr>
              ))}
            </TableBody>
          </Table>
        </section>

        <section className="notes safe" id="safe">
          <div className="notes-head">
            <span className="notes-no">Part 3</span>
            <h2>How we keep files safe.</h2>
          </div>
          <ol className="judgment" start={4}>
            <li>
              <h3>Australian files stay in Australia.</h3>
              <p>Data for Australian firms is stored in Sydney; UK firms are stored in the UK.</p>
            </li>
            <li>
              <h3>Every decision is sealed to the one before it.</h3>
              <p>A changed or missing entry in the activity log shows up as soon as anyone verifies the chain.</p>
            </li>
            <li>
              <h3>Restricted reports stay restricted.</h3>
              <p>Only the compliance officer and named people can see that a report exists. Everyone else sees nothing at all, so nobody tips off the client.</p>
            </li>
            <li>
              <h3>Seven years, then a reviewed disposal.</h3>
              <p>Records are kept for the statutory period after the relationship ends, and nothing is deleted without a person approving it.</p>
            </li>
          </ol>
        </section>

        <section className="closing">
          <div className="board closing-board" aria-hidden />
          <div className="closing-inner">
            <h2>Who is behind your next client?</h2>
            <div className="cta">
              <Button
                variant="string"
                onClick={() => {
                  window.scrollTo({ top: 0, behavior: reduced ? "auto" : "smooth" });
                  setTimeout(() => input.current?.focus(), reduced ? 0 : 500);
                }}
              >
                <Spline />
                Trace a client
              </Button>
              <Button variant="link" onClick={openFiles}>
                Open Harbourline’s files →
              </Button>
            </div>
            <p className="fine2">Kinroot · Sample firm and sample data throughout · Designed to support, not replace, your AML/CTF programme.</p>
          </div>
        </section>
      </main>
    </div>
  );
}
