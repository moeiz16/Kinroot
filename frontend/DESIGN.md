# Kinroot frontend design v3: the structure chart

> v3 replaces "brief and exhibit" (v2) and "the investigation board" (v1). Same product, data, routes, roles and tests of intent; a new face. Everything below is what the app is built to: concept, shell, page skeletons, tokens, type, the chart's visual language and motion.

Kinroot is customer due diligence and beneficial-ownership software for Australian law firms, accountants and conveyancers coming under the AML/CTF Act through the Tranche 2 reforms, and for UK firms under the Money Laundering Regulations 2017. The demo firm is **Harbourline Legal (Sydney)**.

Stack (unchanged): React + Vite + React Router + TanStack Query + Tailwind 4.1, **shadcn/ui** on Radix (`src/components/ui/`, fully re-skinned from the tokens below), TanStack Table, cmdk, Sonner, Motion, lucide-react, **Sigma.js 3 + graphology** kept under the chart as the camera (pan, pinch and zoom) only; every shape, line and label is now drawn by Kinroot's own layer.

---

## 1. What changed and why

The owner looked at v2 and said it still looked like v1. He was right: oxblood on a cool grey board, an ink-black icon spine, a force-drawn network with small shapes and side labels, and the same two columns on every screen. Across the portfolio, headings had converged on large sentence-case serif or grotesk. v3 changes every layer at once:

| | v1 / v2 | v3 |
|---|---|---|
| Accent | Oxblood 350° on cool grey | **Moss / olive ≈ 82°** on warm bone paper |
| Shell | Dark icon spine on the left | **The trail bar** on top: your path through the file as a chain of shapes, tallies, Find, and a full-screen **Index** |
| Skeleton | Record beside board, mirrored, on every screen | **Seven skeletons**, chosen by screen type (§4); the chart sits *above* the record, never beside it |
| Headings | Besley / Spectral serif, sentence case | **Syne 800, uppercase, wide, tight leading, poster scale** |
| Graph | Force-placed pins, labels beside small shapes, straight arrows, red string | **A lawyer's structure chart**: owners above, labels inside shaped plates, elbow lines, % on the owner's drop, a moss trace that climbs |
| Minimap | Scatter thumbnail | **Depth gauge**: one tick per layer of ownership, with the visible window bracketed |
| Corners | 2 px everywhere | **Leaf corners** (`12px 2px`): round on two opposite corners, sharp on the other two |
| Motion | "Tracing": unfold, slack-to-taut string, stitch | **"Rise"**: plates rise layer by layer, the trace climbs elbow by elbow, titles set from the baseline |

## 2. Concept: the structure chart

When a corporate lawyer or accountant explains who owns a client, they draw a **structure chart**: the client at the foot, its shareholders above it, their shareholders above them; a box for a company, an oval for a trust, a circle for a person; percentages written on the lines. Company registers print entity names in capitals. Kinroot v3 takes its whole look from that drawing and that register.

- Every client is drawn as a structure chart, **owners above, the client at the foot**. Reading upward is reading toward the people who really own it.
- Following a person to the client is a **trace**: a thick moss line climbs from the client, elbow by elbow, to the owner, multiplying the percentages as it goes ("100% × 80% × 62% = 49.6%").
- Your **trail** across the top is the path you took through the files today: Desk, then a client, then the owner you opened, drawn as the same shapes joined by the same elbow lines.
- Page titles are set like register extracts and posters: **capitals, extended, heavy, tight**.

The user's question is unchanged: *who is really behind this client, and what do I need to check before we act?*

### Primary workflows by role (unchanged)

| Role | They come to Kinroot to… | Their main path |
|---|---|---|
| Compliance officer (MLRO in the UK) | clear what is waiting: sign off, decide matches, review alerts, file reports | Desk → ticket → dossier → sign off · Fuse or split · Screening · Alerts · Reports (restricted) · Programme |
| Fee earner | open a matter for a new client and know whether they can proceed | Onboard → send the client link → watch the chart fill → ready for sign-off |
| Partner | know the firm's exposure and what is overdue | Programme → partners' brief → high-risk clients |
| Auditor (read only) | check who decided what, and why | Activity log (verify the chain) → a dossier's Timeline and Risk |

## 3. The shell: the trail bar and the Index

No sidebar, no spine, no rail, no dock, no right panel. One bar, 60 px, on top of every app screen:

```
[◎┐ KINROOT]  DESK ─┐ HARBOUR QUAY DEVELOPMENTS ─┐ ○ AVA CALDER        4 SCREEN · 2 FUSE · 3 ALERTS   [Find /]  [▦ Index]  (DC)
```

1. **Wordmark**: the mark (a circle over a box joined by an elbow) and KINROOT in Syne 800.
2. **The trail**: the last five places you opened, in order, each a hop with its shape glyph (□ company, ⬭ trust, ○ person, ▭ page) and a short name, joined by elbow connectors; the current hop is bold. Clicking a hop goes back there. Kept per tab (sessionStorage). On phones only the current hop shows.
3. **Tallies**: the queues that wait on you, as mono numbers with words ("4 to screen · 2 to fuse · 3 alerts"); each is a link. Only queues the role can act on appear.
4. **Find** (`/` or ⌘K) opens the command palette.
5. **Index** (`.` or the button) drops a full-screen sheet from the top: every destination as a poster-sized word in three columns, WORK (Desk, Clients, Onboard a client), DECIDE (Fuse or split, Screening, Alerts, Reports · restricted, Ask the board), RECORD (Programme, Activity log, Settings), each with its count and key. The Index is also the phone navigation. It is a Radix dialog: focus is trapped, Esc closes it.
6. **Account**: initials; the menu holds the firm switcher, light/dark and sign out.

This is derived from how investigators work (Sayari's hop log, i2's link charts, a lawyer's structure chart) and from how they move: from a queue into a client into a person and back. It matches no row in the design registry: not a masthead of tabs, a tiling console, a pill dock, a query strip, a title block, a devtools dock, notebook cells, sheet tabs, Miller columns or a terminal.

## 4. Page skeletons (by screen type)

The app content scrolls as a page under the trail bar. Seven skeletons; no screen uses a side-by-side record and board.

| Skeleton | Used by | Shape |
|---|---|---|
| **Desk** | `/board` | Poster band (a giant count numeral + "WAITING ON YOU" + lenses) → **ticket rail** (each waiting decision as a ticket, sliding horizontally, earliest due first) → **the book chart** (the client book as one network, full width) |
| **Register** | `/clients`, `/screening`, `/alerts`, `/fuse`, `/activity` | Poster title with a count → facet words → full-width ruled register (TanStack Table) with a structure glyph per client. No chart |
| **Chart over record** | dossier `/clients/:id/:tab`, `/alerts/:id`, `/ask`, `/onboard` | Masthead (reference line, the name in capitals, stamps) → **chart band** full width (≈ 52 vh) with its own bar (as-at stamp, compare, tools) and the depth gauge → section words (big tabs) → record in a 12-column grid → **decision bar** pinned to the foot of the window |
| **Face-off** | `/fuse/:id`, `/screening/:id` | Masthead with the queue pager → three columns: **Record A · the verdict column · Record B**; each field row is zipped across with an agreement mark in the middle (= same, ≈ close, ≠ differs, ? missing) → chart band with the two records → decision bar |
| **Sealed** | `/reports`, `/reports/:id`, restricted tab | Inverted (ink ground, bone type) in both themes, hatched restriction band, a giant deadline count, one centred document column; redaction bars for summary access |
| **Brief** | `/programme` | Poster title → the partners' brief as large typeset sentences with the numbers set in moss → numbered obligations as a two-up list that light their clients in a strip chart |
| **Form** | `/settings/:section`, sign-in, sign-up, invitation | Poster title → section words → fieldsets in a two-column label/field grid; sign-in is one poster-titled form on bone with a drawn structure chart in the background |

Onboarding uses chart-over-record with a numbered **step ribbon** (01 CLIENT — 02 PEOPLE AND OWNERS — 03 CONSENT — 04 IDENTITY — 05 REVIEW) over the form, under the chart: the chart grows as owners are added. Ask the board sets the question as the masthead and the written answer in a moss-ruled block between the question and the chart.

**Phones (390 px):** every skeleton stacks naturally; the chart band is 56 vh; the trail shows the current hop; the Index is the navigation; decision bars become full-width bottom bars; the face-off zipper becomes field cards with A above B.

## 5. Landing (public `/`): the answer is the headline

Not an interactive type-in, not a scroll story, not a search box, and not headline-left/card-right. The hero is a **poster whose headline is the answer**, stacked top to bottom:

- Top line (Syne 800, capitals): **WHO REALLY OWNS YOUR CLIENT?**
- Under it, one full-width chart stage. Its left end is the answer: the sample client's name and a giant moss figure, **49.6%**, which counts up while the chart beside it climbs from the client to Margaret Calder ("100% × 80% × 62%").
- Three sample switches (**Trust over a company · Circular holding · Nominee director**) swap the poster: the plates rise, the trace climbs, the figure re-counts, the reasons list re-sets.
- CTAs: **Trace a sample client** (replays) and **Open Harbourline's files** (signs into the sample firm).
- Then three bands: WHO IT IS FOR (three roles, each a big numeral and two sentences), THE OBLIGATIONS (Tranche 2 and the UK MLR, table), HOW WE KEEP FILES SAFE (four statements), and a closing poster.

## 6. Type

Fonts are reserved in the portfolio type registry for Kinroot only, bundled offline with @fontsource.

| Role | Face | Use |
|---|---|---|
| Headings | **Syne** 700–800 | Page titles, mastheads, section words, poster numerals, the wordmark. **Uppercase**, letter-spacing −0.01em, line-height 0.9 |
| UI / body | **Onest** 400–700 | Everything readable: body 15 px/1.55, labels 13 px 600, plates 12.5 px 600 |
| Numbers / IDs | **Martian Mono** 400–600 | Percentages, dates, ACNs, citation ids, counts, the reference line (10.5 px, uppercase, tracked +0.06em) |

Scale (desktop → phone): poster numeral 168 → 96 · page title `clamp(40px, 5.4vw, 84px)` · masthead name `clamp(34px, 4.2vw, 64px)` · section word 22 → 18 · band heading 28 → 22 · body 15 · small 13 · micro mono 10.5. Accessible names stay in normal case (CSS `text-transform` only).

## 7. Palette (tokens)

Light is the default. Hue family: moss/olive ≈ 82° (HSL). Oxblood and the cool grey board are retired. Measured WCAG contrast is in the last column.

| Token | Light | Dark | Use / contrast (light) |
|---|---|---|---|
| `--paper` | `#F1EFE3` | `#11130B` | page ground |
| `--surface` | `#FAF9F2` | `#191C12` | plates, tickets, inputs |
| `--sunk` | `#E6E4D3` | `#22261A` | chart ground, table heads |
| `--ink` | `#1B1D13` | `#ECEDDF` | text 14.8:1 |
| `--ink-2` | `#3D4030` | `#C8CAB4` | secondary text 9.2:1 |
| `--muted` | `#5C5F4C` | `#9B9E86` | captions 5.7:1 |
| `--rule` | `#CDCAB5` | `#353A29` | hairlines |
| `--rule-strong` | `#7E806B` | `#8A8D76` | control borders 3.5:1 |
| `--moss` | `#4F6B1E` | `#A8C45E` | accent, primary action, trace 5.3:1 |
| `--moss-ink` | `#3D5516` | `#BCD777` | links 7.3:1 |
| `--moss-tint` | `#DFE6C4` | `#29321A` | selection, chips |
| `--lichen` | `#CFDD8E` | `#3B4720` | highlighter under numbers |
| `--on-moss` | `#F8F9EF` | `#141709` | text on moss 5.7:1 |
| `--high` / tint | `#A93D16` / `#F6DFD3` | `#F0895C` / `#3A2116` | high risk, hits 5.4:1 |
| `--review` / tint | `#7E5A00` / `#F2E5C3` | `#E3B64C` / `#352B12` | review, possible match 5.4:1 |
| `--info` / tint | `#35577D` / `#DCE4EE` | `#93B3DA` / `#1C2735` | monitoring, notes 6.5:1 |
| `--sealed` / `--on-sealed` | `#1B1D13` / `#ECEDDF` | `#060704` / `#ECEDDF` | the sealed skeleton |

## 8. Status language (never colour alone)

| Status | Glyph | Word | Colour |
|---|---|---|---|
| Clear | ● | "Clear" / "ID verified" | moss on moss tint |
| Review | ◆ | "Review" / "Ask client" | review on tint |
| High | ▲ | "High" / "Possible sanctions match" | high on tint |
| Restricted | lock + hatch | "Restricted" | sealed ground |
| Unknown | ? in a dashed plate | "Not yet known" | muted |
| New since | + on a moss tag | "New since 3 Mar" | moss |
| Removed | – and a struck plate at 40% | "Removed 2 Sep" | muted |
| Beneficial owner | moss-filled plate + "OWNER 49.6%" tab | "Beneficial owner · 49.6%" | moss |

Match likelihood is always "87 in 100".

## 9. Components (shadcn/ui, re-skinned)

- **Leaf corners**: `--r-leaf: 12px 2px` on buttons, inputs, tickets, popovers and dialogs (`20px 3px` for large surfaces, `8px 1px` for badges). Never pills, never uniform radius.
- **Borders over shadows**: 1.5 px `--rule-strong` on controls, 1 px `--rule` hairlines between rows, a 3 px ink rule under mastheads. Floating layers (popover, menu, dialog, Index) get a 1.5 px ink border and a hard **offset plate** shadow `6px 6px 0 var(--moss-tint)`; no blur shadows anywhere.
- **Buttons**: primary = moss fill, on-moss text, Onest 700 14 px, uppercase-free; secondary = ink outline; quiet = text with a moss underline on hover. Height 40 (sm 32).
- **Inputs**: surface fill, 1.5 px rule-strong border, leaf corners, focus = 3 px moss ring with a 2 px paper gap.
- **Tabs** (section words): Syne 800 uppercase words with a 4 px moss bar under the active one; counts as mono superscripts.
- **Tables** (registers): Onest, 52 px rows, sunk header with mono micro labels, hover row in moss tint.
- **Badges** (stamps): glyph + word, leaf corners `8px 1px`, tinted ground, 1 px tone border.
- **Focus**: `0 0 0 2px var(--paper), 0 0 0 5px var(--moss)` on everything, including chart plates.

## 10. The chart's visual language

Drawn by `src/graph/engine.ts` (HTML plates + one SVG for lines) over a Sigma camera. Wheel zoom needs ⌘/Ctrl (trackpad pinch works) so the page scrolls normally.

- **Orientation**: owners above, the client at the foot (`rise` orientation). The client book (Desk) keeps a clustered network layout.
- **Plates** (labels inside the shape, after legal structure-chart convention):
  - company: rectangle 180 × 58, 2 px corners, name (Onest 600) + register number (Martian Mono);
  - trust: **oval** (ellipse) 184 × 62;
  - person: **circle** 46 px with initials, name and role set beneath;
  - partnership: rectangle with a small triangle in the top-left corner (flow-through);
  - unknown: dashed rectangle with "?";
  - stack (many companies): three offset rectangles;
  - address: small diamond; sanctions/PEP list entry: rectangle with a hatched band and "LIST" tab;
  - **client**: moss-filled rectangle, on-moss type, a 4 px ink foot rule ("ground").
- **Lines** (all elbowed with 10 px rounded corners and a small solid arrowhead into the subject, after the Open Ownership BOVS):
  - owns: solid 1.6 px ink; % in a mono tag on the owner's drop;
  - controls: dashed 6/4 in ink-2 with the role word;
  - unknown: dotted 1/4 in muted with "?%";
  - possible duplicate: double hairline in moss;
  - shared (Desk): 1 px rule hairline, straight.
- **Layer rules**: faint horizontal bands with mono labels at the left edge (CLIENT, LAYER 1, LAYER 2…).
- **The trace**: a 5 px moss line with a 9 px paper underlay, drawn over the elbows from the client upward; plates on the path take a moss ring as the head passes; a mono **counter** rides the head showing the running product; the owner plate fills moss and gets an "OWNER 49.6%" tab. Faint secondary paths are 2 px moss at 45%.
- **Compare** (before/after): added lines and plates carry a moss "+ NEW SINCE 3 MAR" tag; removed ones are dashed and struck at 40% with "– REMOVED".
- **Fuse / split seam**: the two records joined by a moss **zip** (a run of short ticks); fuse slides the plates together into one double-outlined plate (*Graft*); split opens the zip from the top (*Cleave*). Dragging one plate onto the other still fuses.
- **Depth gauge** (the minimap): a 44 px column at the chart's right edge, one tick per layer with tiny shape glyphs for what is on it; the visible window is bracketed; click a layer to pan to it. On the Desk it is a book map drawn with the same glyphs.
- **Text twin**: every chart has a screen-reader list of the same people and links; plates are buttons; arrow keys move along links; `T` traces.

## 11. Motion: "Rise"

Motion (framer-motion) for UI, the engine's own tweens for the chart; all transform/opacity; `prefers-reduced-motion` makes every one instant.

| Name | What moves | Timing |
|---|---|---|
| **Set** | Page titles rise from a baseline mask (clip-path inset) | 420 ms, `cubic-bezier(.2,.8,.2,1)` |
| **Rise** | Plates rise from the plate they own, layer by layer | 560 ms per layer, 70 ms apart, slight overshoot |
| **Climb** | The trace draws upward elbow by elbow; the counter ticks the product | 1000 ms |
| **Ticket slide** | Desk tickets slide in from the right, staggered | 40 ms stagger |
| **Drop** | The Index falls from the top; its words stagger in | 320 ms |
| **Graft / Cleave** | Fuse slides two plates into one; split opens the zip | 420 / 480 ms |
| **Seal** | Sealed pages arrive through a diagonal hatch wipe | 500 ms |

## 12. Copy voice (unchanged rules)

Precise, legal, calm, plain words for clients and partners. CTAs: Trace a sample client · Open Harbourline's files · Trace · Fuse into one person · Keep apart · Split into two · Sign off · Re-rate · Pin to dossier · Export for AUSTRAC · Mark as filed · Verify the chain · Invite someone. Compliance claims say "designed to support"; never "certified" or "compliant". Never in rendered text: RAG, retrieval, embeddings, vector, rerank, LLM, model or provider names, prompt, tokens, SQL, architecture, pipeline, latency, fallback, cache, "AI-powered", "smart", "algorithm", "node", "edge". Restricted copy says what to do, never what is inside. Hard-coded copy is written as of October 2025; Tranche 2 "commences 1 July 2026" and the countdown is computed at runtime.

## 13. References

Studied before v3 (the v2 list of 29 domain references still informs the features).

| # | Reference | What v3 takes |
|---|---|---|
| 1 | Open Ownership, Beneficial Ownership Visualisation System: https://www.openownership.org/en/publications/beneficial-ownership-visualisation-system/relationships-arrows/ | Arrows always carry a head; elbowed lines are allowed; non-interest links lighter. → Elbow lines with small heads; control dashed and lighter |
| 2 | Corporate structure chart conventions (Lexchart guide: https://lexchart.com/the-ultimate-guide-to-company-structure-charts/ ; schematex entity shapes: https://schematex.js.org/docs/entity) | Companies as rectangles, trusts as ovals, individuals as circles, flow-through entities marked with a triangle; parents above subsidiaries. → The plate grammar and the owners-above orientation |
| 3 | Discern, entity structure charts: https://www.discern.com/resources/entity-structure-chart | Percentages written on the line, legend always present. → % tags on each owner's drop; a legend in the chart bar |
| 4 | Sayari Graph: https://sayari.com/platform/graph/ | Traversal as a log of hops. → The trail bar is a hop log of your own path |
| 5 | ICIJ Offshore Leaks: https://offshoreleaks.icij.org/pages/howtouse | A text list of every connection beside the graph. → Text twin and the Owners section |
| 6 | OCCRP Aleph: https://data.occrp.org and the GIJN Aleph guide https://gijn.org/resource/using-aleph/ | Entity pages that read as documents first, network second. → Chart *over* record, both on one scrolling page |
| 7 | Hummingbird case management: https://www.hummingbird.co/use-cases/aml | Timeline sorted by due date, urgent cases first. → The ticket rail, earliest due first |
| 8 | Linear triage: https://linear.app/docs/triage | Keyboard-first queue work. → `F` / `K` / `J` in decision bars, `[` `]` between sections, `.` for the Index |
| 9 | Syne (Bonjour Monde): https://rightfontapp.com/family/syne and https://madegooddesigns.com/syne-font/ | Gets wider as it gets bolder, "forcing radical graphic design choices". → Poster-scale uppercase headings, used for headings only |
| 10 | Company register extracts (ASIC, Companies House) | Entity names printed in capitals in a register layout. → Uppercase mastheads, mono reference lines |
| 11 | Swiss/International-style posters (Müller-Brockmann's grid, *Grid Systems in Graphic Design*) | Big type on a strict grid, few colours, rules not boxes. → 12-column page grid, heavy rules, no cards for the sake of cards |
| 12 | shadcn/ui on Tailwind v4: https://ui.shadcn.com/docs/tailwind-v4 | Tokens through `@theme inline`, `data-slot` on every primitive. → The component system, re-skinned |
| 13 | Sigma.js v3: https://www.sigmajs.org/ | Camera, gestures and `setCustomBBox`. → Kept as the chart's camera only |

## 14. Build notes

- Shell: `src/shell/AppShell.tsx` (trail bar, Index, account), `src/shell/trail.ts` (hop log), `src/shell/page.tsx` (skeleton primitives: `Page`, `Masthead`, `SectionTabs`, `DecisionBar`, `QueuePager`, `ChartBand`), `src/shell/chart.tsx` (chart bar, tools, legend, depth gauge), `src/shell/board.tsx` (one chart per page, mounted inside the page's chart band).
- Styles: `src/styles/index.css` (tokens, base, components, chart), `src/routes/pages.css` (skeletons), `src/routes/landing/landing.css`.
- Every screen keeps its route, data, roles and keyboard paths; only the face changed.
