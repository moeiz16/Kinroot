// Public landing: the answer is the headline. The poster asks WHO REALLY OWNS YOUR CLIENT?; under it, a sample
// client's structure chart rises, the moss trace climbs from the client to the owner, and the giant figure counts
// to the answer (49.6%). Three sample switches swap the poster. Then three bands: who it is for, the obligations,
// and how files are kept safe. See DESIGN.md §5.
import { ArrowRight, Spline } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { BoardEngine, webglAvailable } from "../graph/engine";
import { DEMO_PASSWORD, useAuth } from "../lib/auth";
import { tranche2Line } from "../lib/dates";
import { prefersReduced } from "../lib/theme";
import { PHONE, useMedia } from "../lib/useMedia";
import { KindGlyph, Mark } from "../shell/chart";
import { SCENARIOS, type Scenario } from "./landing/scenarios";
import "./landing/landing.css";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const figureOf = (s: string) => Number(s.replace(/[^0-9.]/g, "")) || 0;

export default function Landing() {
  const host = useRef<HTMLDivElement>(null);
  const engine = useRef<BoardEngine | null>(null);
  const runId = useRef(0);
  const phone = useMedia(PHONE);
  const reduced = prefersReduced();
  const [scenario, setScenario] = useState<Scenario>(SCENARIOS[0]!);
  const [figure, setFigure] = useState(reduced ? SCENARIOS[0]!.answer.figure : "0%");
  const [phase, setPhase] = useState<"rising" | "climbing" | "done">(reduced ? "done" : "rising");
  const [canDraw] = useState(() => webglAvailable());
  const [opening, setOpening] = useState(false);
  const nav = useNavigate();
  const { signIn } = useAuth();

  useEffect(() => {
    if (!host.current || !canDraw) return;
    const e = new BoardEngine(host.current, { reduced, pad: { x: 220, y: 150 }, ariaLabel: "Sample ownership structure" });
    engine.current = e;
    const ro = new ResizeObserver(() => e.resize());
    ro.observe(host.current);
    return () => {
      ro.disconnect();
      e.destroy();
      engine.current = null;
    };
  }, [canDraw, reduced]);

  useEffect(() => {
    engine.current?.setInsets(phone ? { top: 24, left: 8, right: 8, bottom: 20 } : { top: 64, left: 560, right: 40, bottom: 30 });
  }, [phone, canDraw]);

  /** Count the figure up while the trace climbs. */
  const count = useCallback(
    async (target: string, id: number, dur: number) => {
      const to = figureOf(target);
      const decimals = target.includes(".") ? 1 : 0;
      if (reduced || !to) {
        setFigure(target);
        return;
      }
      const t0 = performance.now();
      await new Promise<void>((done) => {
        const step = (now: number) => {
          if (runId.current !== id) return done();
          const t = Math.min(1, (now - t0) / dur);
          const v = to * (1 - Math.pow(1 - t, 2.4));
          setFigure(`${v.toFixed(decimals)}%`);
          if (t < 1) requestAnimationFrame(step);
          else done();
        };
        requestAnimationFrame(step);
      });
      setFigure(target);
    },
    [reduced],
  );

  const run = useCallback(
    async (s: Scenario) => {
      const id = ++runId.current;
      const e = engine.current;
      setScenario(s);
      if (!e) {
        setFigure(s.answer.figure);
        setPhase("done");
        return;
      }
      setFigure(reduced ? s.answer.figure : "0%");
      setPhase(reduced ? "done" : "rising");
      // The scenarios are drawn client-on-top; the chart puts owners above, so flip them.
      await e.setScene({ key: `${s.id}-${id}`, nodes: s.nodes.map((n) => ({ ...n, label: n.client ? s.name : n.label, y: -n.y })), edges: s.edges }, { hold: true });
      await e.unfoldAll();
      await wait(reduced ? 0 : 200);
      if (runId.current !== id) return;
      setPhase("climbing");
      await Promise.all([e.pull([s.string], { animate: !reduced, dur: 1100 }), count(s.answer.figure, id, 1100)]);
      if (s.ownerSub) e.setNodeSub(s.ownerSub.id, s.ownerSub.text);
      if (runId.current === id) setPhase("done");
    },
    [reduced, count],
  );

  useEffect(() => {
    if (!canDraw) {
      setFigure(SCENARIOS[0]!.answer.figure);
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

  const openFiles = async () => {
    setOpening(true);
    try {
      await signIn("daniel@harbourline.example", DEMO_PASSWORD);
      nav("/board");
    } catch {
      nav("/sign-in?demo=1");
    }
  };

  const a = scenario.answer;
  return (
    <div className="landing">
      <header className="lp-top">
        <Link className="wordmark" to="/" aria-label="Kinroot home">
          <Mark />
          <span className="wm">Kinroot</span>
        </Link>
        <nav className="lp-nav" aria-label="Main">
          <a href="#who">Who it is for</a>
          <a href="#regimes">Tranche 2 and the UK MLR</a>
          <a href="#safe">How we keep files safe</a>
          <Link to="/sign-in" className="lp-signin">
            Sign in
          </Link>
        </nav>
      </header>

      <main>
        <section className={`lp-hero ${phase}`} aria-label="A sample client, traced">
          <div className="lp-kicker">Client due diligence for law firms, accountants and conveyancers</div>
          <h1 className="lp-title">
            <span className="set">Who really owns your client?</span>
          </h1>

          <div className="lp-stage">
            <div className="lp-answer" aria-live="polite">
              <span className="k">Sample client</span>
              <b className="lp-client">
                <KindGlyph kind={scenario.nodes.find((n) => n.client)?.kind ?? "company"} size={15} />
                {scenario.name}
              </b>
              <div className="lp-figure" aria-hidden={phase !== "done"}>
                {figure}
              </div>
              <p className="lp-who">
                <b>{a.who}</b> {a.line}
              </p>
              <div className="lp-working">
                <span className="k">Working</span> {a.working}
              </div>
            </div>
            <div ref={host} className="chart" aria-hidden={!canDraw} />
            <div className="lp-switch" role="group" aria-label="Sample structures">
              {SCENARIOS.map((s) => (
                <button key={s.id} type="button" className="lp-chip" aria-pressed={scenario.id === s.id} onClick={() => void run(s)}>
                  {s.chip ?? "Company with an offshore layer"}
                </button>
              ))}
            </div>
            <span className="lp-sample">Sample structure · not a real company</span>
          </div>

          <div className="lp-under">
            <div className="lp-verdict">
              <span className={`lp-look ${scenario.slip.look}`}>
                <span aria-hidden>{scenario.slip.look === "high" ? "▲" : "◆"}</span> {scenario.slip.look === "high" ? "High" : "Review"} · {scenario.slip.lead}
              </span>
              <h2>{scenario.slip.title}</h2>
              <p>{scenario.slip.next}</p>
            </div>
            <ol className="lp-reasons">
              {scenario.slip.reasons.map((r) => (
                <li key={r.n}>
                  <span className="n">{String(r.n).padStart(2, "0")}</span>
                  <span>{r.text}</span>
                </li>
              ))}
            </ol>
            <div className="lp-cta">
              <Button variant="primary" onClick={() => void run(scenario)}>
                <Spline />
                Trace a sample client
              </Button>
              <Button variant="ink" onClick={openFiles} disabled={opening}>
                {opening ? "Opening…" : "Open Harbourline’s files"} <ArrowRight />
              </Button>
              <p className="lp-fine">
                Designed to support the AML/CTF Act 2006 and the UK Money Laundering Regulations 2017. <span>{tranche2Line()}</span>
              </p>
            </div>
          </div>
        </section>

        <section className="lp-band" id="who">
          <header className="lp-band-head">
            <span className="n">01</span>
            <h2>Three people sign off on a client. Each sees the part they need.</h2>
          </header>
          <ol className="lp-roles">
            <li>
              <span className="lp-role">Fee earners</span>
              <h3>Open a matter without a week of forms.</h3>
              <p>Send the client one link. Identity checks, ownership and consent arrive in the file, already traced to the people behind it.</p>
            </li>
            <li>
              <span className="lp-role">Compliance officers</span>
              <h3>Sign off with the reasons in front of them.</h3>
              <p>Every rating comes with the sentences behind it, each citing the link it rests on. Enhanced checks are triggered for you, and nothing proceeds until you sign.</p>
            </li>
            <li>
              <span className="lp-role">Partners</span>
              <h3>Know the firm’s exposure on one page.</h3>
              <p>Overdue reviews, high-risk clients and open screening matches, in plain words, ready for the next partners’ meeting.</p>
            </li>
          </ol>
        </section>

        <section className="lp-band" id="regimes">
          <header className="lp-band-head">
            <span className="n">02</span>
            <h2>Built for Tranche 2 and the UK MLR 2017.</h2>
          </header>
          <p className="lp-band-sub">Obligation by obligation, this is where Kinroot does the work. It is designed to support your AML/CTF programme; your firm stays responsible for it.</p>
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
                ["Find the real owners", "Beneficial owners at 25% or control", "Beneficial owners over 25% or control", "The trace: compounded ownership through every layer"],
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
                  <td className="in-kinroot">{r[3]}</td>
                </tr>
              ))}
            </TableBody>
          </Table>
        </section>

        <section className="lp-band" id="safe">
          <header className="lp-band-head">
            <span className="n">03</span>
            <h2>How we keep files safe.</h2>
          </header>
          <ol className="lp-safe">
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

        <section className="lp-closing">
          <h2>Who is behind your next client?</h2>
          <div className="lp-cta">
            <Button
              variant="primary"
              onClick={() => {
                window.scrollTo({ top: 0, behavior: reduced ? "auto" : "smooth" });
                setTimeout(() => void run(scenario), reduced ? 0 : 500);
              }}
            >
              <Spline />
              Trace a sample client
            </Button>
            <Button variant="line" onClick={openFiles}>
              Open Harbourline’s files <ArrowRight />
            </Button>
          </div>
          <p className="lp-fine">Kinroot · Sample firm and sample data throughout · Designed to support, not replace, your AML/CTF programme.</p>
        </section>
      </main>
    </div>
  );
}
