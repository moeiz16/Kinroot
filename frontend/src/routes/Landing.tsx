// Public landing: one question, one sentence, one button, and a live sample chart that traces a client to its owner
// (the share counts up in a chip). Sample switches swap the structure; a risk chip opens the reasons. Then three
// one-line points and the compliance line. See DESIGN.md §3.
import { ArrowRight, BellRing, Moon, ShieldCheck, Spline, Sun } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { BoardEngine, webglAvailable } from "../graph/engine";
import { DEMO_PASSWORD, useAuth } from "../lib/auth";
import { tranche2Line } from "../lib/dates";
import { applyTheme, prefersReduced, useTheme } from "../lib/theme";
import { PHONE, useMedia } from "../lib/useMedia";
import { Mark } from "../shell/chart";
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
  const theme = useTheme();
  useEffect(() => {
    document.title = "Kinroot · Who really owns your client?";
  }, []);

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
    engine.current?.setInsets(phone ? { top: 70, left: 8, right: 8, bottom: 70 } : { top: 70, left: 40, right: 40, bottom: 70 });
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
        const step = () => {
          if (runId.current !== id) return done();
          const t = Math.min(1, (performance.now() - t0) / dur);
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
  const noOwner = figureOf(a.figure) === 0;
  return (
    <div className="landing">
      <header className="lp-top">
        <Link className="wordmark" to="/" aria-label="Kinroot home">
          <Mark />
          <span className="wm">Kinroot</span>
        </Link>
        <nav className="lp-nav" aria-label="Main">
          <button type="button" className="bar-icon" aria-label={theme === "dark" ? "Light mode" : "Dark mode"} onClick={() => applyTheme(theme === "dark" ? "light" : "dark", true)}>
            {theme === "dark" ? <Sun /> : <Moon />}
          </button>
          <Link to="/sign-in" className="lp-signin">
            Sign in
          </Link>
        </nav>
      </header>

      <main>
        <section className="lp-hero" aria-label="A sample client, traced">
          <h1 className="lp-title">Who really owns your client?</h1>
          <p className="lp-sub">Kinroot traces every layer of a client to the people behind it.</p>
          <div className="lp-cta">
            <Button variant="primary" onClick={openFiles} disabled={opening}>
              {opening ? "Opening…" : "Open the sample firm"} <ArrowRight />
            </Button>
          </div>

          <div className={`lp-stage ${phase}`}>
            <div ref={host} className="chart" aria-hidden={!canDraw} />
            <div className="lp-switch">
              <ToggleGroup type="single" aria-label="Sample structures" value={scenario.id} onValueChange={(v) => v && void run(SCENARIOS.find((s) => s.id === v)!)}>
                {SCENARIOS.map((s) => (
                  <ToggleGroupItem key={s.id} value={s.id} aria-label={s.chip ?? "Company with an offshore layer"}>
                    {s.chip ?? "Offshore layer"}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>
            <span className="lp-sample">Sample</span>
            <div className="lp-answer" aria-live="polite">
              <span className="chip lp-owner" title={`${a.who} ${a.line}`}>
                <span className="sw" aria-hidden />
                {noOwner ? "No owner found" : a.who}
                {!noOwner && <b aria-hidden={phase !== "done"}>{figure}</b>}
              </span>
              <Popover>
                <PopoverTrigger asChild>
                  <button type="button" className="chip">
                    <span className={`dot ${scenario.slip.look === "high" ? "lp-high" : "lp-review"}`} aria-hidden />
                    {scenario.slip.look === "high" ? "High risk" : "Review"}
                  </button>
                </PopoverTrigger>
                <PopoverContent align="start" side="top" className="w-[320px] p-4">
                  <p className="lp-pop-title">{scenario.slip.title}</p>
                  <ol className="lp-reasons">
                    {scenario.slip.reasons.map((r) => (
                      <li key={r.n}>{r.text}</li>
                    ))}
                  </ol>
                </PopoverContent>
              </Popover>
            </div>
          </div>
        </section>

        <section className="lp-points" aria-label="What Kinroot does">
          <div>
            <Spline aria-hidden />
            <h2>Trace the owners</h2>
            <p>Every layer, multiplied through to the person.</p>
          </div>
          <div>
            <ShieldCheck aria-hidden />
            <h2>Check the lists</h2>
            <p>Sanctions and PEP matches, each decided with a reason.</p>
          </div>
          <div>
            <BellRing aria-hidden />
            <h2>Keep watch</h2>
            <p>Alerts when owners, officers or lists change.</p>
          </div>
        </section>

        <footer className="lp-foot">
          <span>Designed to support the AML/CTF Act 2006 and the UK Money Laundering Regulations 2017.</span>
          <span>{tranche2Line()}</span>
          <span>Sample firm and data.</span>
        </footer>
      </main>
    </div>
  );
}
