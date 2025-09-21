# Kinroot frontend design: the investigation board

> Copy this file to `~/Work/kinroot/frontend/DESIGN.md`. The static prototype lives in `prototype/` next to this file (open `index.html`, `dossier.html` or `fuse.html` directly; add `?theme=dark` or `?still` for the settled, reduced-motion state). Screenshots are in `shots/`. Build to this document; the prototype is the visual reference for type, colour, spacing and the graph grammar.

Kinroot is customer due diligence and beneficial-ownership software for Australian law firms, accountants and conveyancers coming under the AML/CTF Act through the Tranche 2 reforms, and for UK firms under the Money Laundering Regulations 2017. The demo firm is **Harbourline Legal (Sydney)**.

Stack: React + Vite + React Router + TanStack Query + Tailwind 4.1 (tokens below go into `@theme`), **Sigma.js 3 + graphology** for the board, Motion (framer-motion) for layout and UI motion, lucide-react for icons.

---

## 1. References

Every reference was re-opened in November 2026. Where a vendor page is marketing-only, the "take" comes from their documentation or release notes, as noted.

| # | Reference | What we take |
|---|---|---|
| 1 | Sayari Graph: https://sayari.com/platform/graph/ | Ownership traversal shown as a *log of hops* ("7-hop ownership chain traversed"), and source-linked evidence on every connection. → Each edge in Kinroot carries a citation id (`E-07`) and a source (register extract, client document); reasons and assistant answers cite edges, not paragraphs. |
| 2 | Quantexa graph analytics: https://quantexa.com/platform/graph-analytics/ and entity resolution: https://www.quantexa.com/entity-resolution/ | A network *generated around one entity for one decision*, and the ability to drill into a resolved entity to see which records were matched and why. → The dossier graph is always centred on one client; the fuse/split "match file" lists both source records field by field. |
| 3 | Open Ownership BOVS: https://www.openownership.org/en/publications/beneficial-ownership-visualisation-system/ (Parties, Relationships, Colour, Annotation, Unknowns pages) | The node and edge grammar: one shape per party type, an arrow always has a head and runs from the interested party to the subject, annotation "Owns 10%" at the start of the arrow, "?%" for unknown strength, indirect interests dotted and labelled with the *compounded* interest, unknown parties as the outline with a question mark, unknown numbers as a dotted **stack** labelled "X or more". Non-interest relationships drawn quieter (a tint). We keep the grammar but use our own colours (BOVS allows brand colours). |
| 4 | Linkurious Enterprise user manual: https://doc.linkurious.com/user-manual/latest/ | Expand-a-node, filter panel, style rules, timeline filter, **sticky notes**, share/publish/export, and alerts that roll up into cases. → "Pin a note" on the board, export of a dossier view as a PDF exhibit, and monitoring alerts grouped per client. |
| 5 | ICIJ Offshore Leaks: https://offshoreleaks.icij.org/pages/howtouse | Every entity page shows the connection graph **and a text list of the same connections** beneath it. → Every graph in Kinroot has a ledger twin (Owners tab), which is also our keyboard and screen-reader path. |
| 6 | Neo4j Bloom: https://neo4j.com/docs/bloom-user-guide/current/ | Saved **search phrases** that map plain questions to graph queries, and the Slicer over a loaded scene. → The assistant's suggested questions ("Who controls…", "What changed for… since…") are phrase templates; the "As at / Compared with" stamp is our slicer. |
| 7 | Palantir Gotham training guide (Histogram helper), via https://assets.documentcloud.org/documents/6204567/PALANTIR-Guide.pdf | Clicking a bar of a frequency helper selects that subset on the graph. → On the constellation, clicking a lens caption ("12 clients share an officer") highlights exactly those pins. |
| 8 | Chainalysis Reactor: https://www.chainalysis.com/product/reactor/ (and The Block, May 2022, on "Storyline") | Trace across unlimited hops; a separate chronological "storyline" view of the same entities. → Dossier **Timeline** tab: the same structure told as dated events (incorporations, appointments, share transfers, screenings). |
| 9 | Maltego Graph release notes and docs: https://docs.maltego.com/en/support/solutions/articles/15000059555 , https://support.maltego.com/en/support/solutions/articles/15000019236-detail-view | **Collection nodes** for many similar entities, hover actions (pin, bookmark, note), and a selected-entity card with previous/next. → Our dotted "41 companies" stack; `J`/`K` previous/next in every review queue. |
| 10 | OpenCorporates corporate networks (ODI write-up): https://theodi.org/news-and-events/blog/power-of-open-data-reveals-global-corporate-networks/ and "corporate sprawl" analysis: https://onlinejournalismblog.com/2012/04/12/mapping-the-tesco-corporate-organisational-sprawl-an-initial-sketch/ | Grouping companies by **shared directors** (co-director projection). → The constellation clusters clients that share an officer or address, which is how nominee-director clusters become visible. |
| 11 | Cambridge Intelligence KeyLines combos: https://cambridge-intelligence.com/?p=30003 | Combos: group nodes and hide the detail beneath them until opened (detail on demand). → A client pin on the constellation opens into its structure; stacks open into their members. (We do **not** take their time bar; a scrubbing ruler belongs to Plotline.) |
| 12 | Kumu views: https://docs.kumu.io/guides/views | Several named views over one map, with a toggle control. → Constellation **lenses** (Risk · Review due · Shared officers · Screening). |
| 13 | Obsidian graph view: https://obsidian.md/help/plugins/graph | Local graph with depth, hover dims everything that is not a neighbour, colour groups by query. → Hover/focus on a node dims non-neighbours to 35%; "Focus mode" limits depth. |
| 14 | Sigma.js: https://www.sigmajs.org/ (v3 API) | WebGL rendering for the full client book, camera animation, reducers for highlight/dim, `setCustomBBox` to stop the camera jumping while nodes unfold, `createEdgeArrowProgram` for weighted arrowheads. |
| 15 | tldraw: https://tldraw.dev/ | Canvas chrome: zoom group, minimap, focus mode, floating UI that never covers the work. |
| 16 | Evidence-board web pieces: Framer "Evidence Board" component https://www.framer.com/community/marketplace/components/evidence-board/ , a blockchain-security site with click-a-node dossiers https://contra.com/p/MsoBgWZY-interactive-website-for-blockchain-security-firm , "Itz Confidential" scroll evidence board https://portfolio-website-lake-tau.vercel.app/work/itz-confidential | The pinned slip, the dossier that opens from a node with hop count and risk, and the red thread. **What we avoid:** corkboard textures, noir black, polaroids, handwritten fonts and neon on black. Kinroot is a clean professional board; the string is the only theatrical element. (No Awwwards/Godly piece matched "legal investigation board" closely; this was checked and these were the nearest.) |

## 2. Metaphor and mental model

**An investigation board with case dossiers.** The compliance officer's question is always the same: *who is really behind this client, and what do I need to check before we act?*

- Every client is a **pin** on the board. Owners, directors, trusts and nominees hang beneath it like **roots** ("Kinroot"): the client sits at the top and its owners grow downward, layer by layer, to the people at the end.
- The path from a person to the client is a **red string**. Pulling it shows how much that person really owns ("100% × 80% × 62% = 49.6%").
- Each client has a **dossier**: a paper file that slides out beside the board with folder tabs.
- Duplicate people and companies are **stitched** together (fuse) or **unpicked** (split).
- Restricted matters (suspicious-matter reports) live behind **hatching and a lock**.

Graph first, forms second. Work means pulling threads and filing the result.

### Primary workflows by role

| Role | They come to Kinroot to… | Their main path |
|---|---|---|
| **Compliance officer** (AML/CTF compliance officer; MLRO in the UK) | clear the tray: sign off ratings, decide matches, review alerts, file reports | Board → file tray → dossier → sign off · Fuse or split queue · Screening queue · Alerts · Reports (restricted) · Programme |
| **Fee earner** (lawyer, accountant, conveyancer) | open a matter for a new client and know whether they can proceed | Onboard a client → send the client link → watch the structure fill in → "Ready for sign-off" |
| **Partner** | know the firm's exposure and what is overdue | Programme → partners' brief → drill into high-risk clients on the board |
| **Auditor** (read only) | check that decisions were made, by whom, with what reasons | Activity log (verify the seal chain) → any dossier's Timeline and Risk tabs |

## 3. Navigation model and app shell

**Spine rail + infinite board + dossier drawer.** No sidebar of text, no org card, no top tab bar.

```
┌────┬──────────────────────────────────────────────────────────────┬──────────────────────────┐
│ ▣  │ [As at 14 Nov │ Compared with 3 Mar · onboarding] (Find a person, company or trust  /)        │
│    │                                                              │ ⌐Summary┐Owners┐Screening│
│ ⌘  │                       ■ client pin                           │┌────────────────────────┐│
│ ▤▸ │                     ╱  │  ╲                                  ││ dossier paper           ││
│ +  │                   ○    ■    ■                                ││                         ││
│ ── │                       ╱ ╲                                    ││                         ││
│ ⑂7 │                      ■   ◰         the board (Sigma)         ││                         ││
│ ⛨3 │                      │                                       ││                         ││
│ ♪5 │                      ● ← red string to the owner             ││                         ││
│ 🔒 │                                                              ││                         ││
│ ⌕  │                                                              ││                         ││
│ ── │ [+ − ⤢][⟋ ◎][minimap]      [○ Person ■ Company ◰ Trust — ┄]  ││                         ││
│ ✓  │                                                              │└────────────────────────┘│
│ ≣  │                                                              │                          │
│ ⚙  │                                                              │                          │
│(HL)│                                                              │                          │
│ PR │                                                              │                          │
└────┴──────────────────────────────────────────────────────────────┴──────────────────────────┘
 64px            board: always present, pans/zooms                      drawer 540px (480–640, resizable)
```

- **Spine rail** (64 px, ink-black in both themes, like the spine of a case binder). Icons only, each with a tooltip and an `aria-label`; the active item gets a 3 px oxblood tab on its left edge. Order: Board · Clients · Onboard │ Fuse or split (count) · Screening (count) · Alerts (count) · Reports (lock; visible only to the compliance officer and delegates) · Ask the board │ Programme · Activity log … Settings · **firm stamp** (round, italic Spectral monogram "HL", rotated −8°, opens the firm switcher) · user initials.
- **The board** is always mounted behind every app route. Most routes are "the board, filtered" plus a drawer or sheet. Floating chrome: the **As at** date stamp (top-left), the **Find** pill (top, centred on the visible board; `/` focuses it), the zoom group + "Pull the thread" + focus mode + minimap (bottom-left), the legend (bottom, centred on the visible board).
- **The dossier drawer** (right, 540 px, resizable 480–640) with **notched folder tabs** that sit on the board above the paper. Pin (📌) keeps a dossier open and lets a second one open beside it for comparison. `Esc` closes. Opening a drawer pans the camera so the selection stays centred in the visible part of the board.
- **Paper sheets** (left, 600–680 px) are used for list-heavy routes (Clients, Activity log, Programme, Settings) and slide over the board from the rail; the board stays visible and filtered on the right.
- Keyboard: `/` find · `T` pull the thread on the focused node · `F`/`K` fuse/keep apart · `J`/`K`-style `J` next item in a queue · `[` `]` previous/next folder tab · `Esc` close · arrow keys move focus between connected nodes (Tab order follows the ledger twin).
- **Mobile (390 px):** the board is full-screen; the drawer becomes a **bottom sheet** with three detents (peek 120 px · half · full) and the folder tabs scroll horizontally; the spine becomes a 5-icon **bottom bar** (Board · Clients · Waiting · Ask · More); floating chrome collapses into one "⋯" button bottom-right; paper sheets go full-screen.

## 4. Landing story (public, `/`)

Archetype: **interactive demo as the hero.** The first screen is the board with a single field: you type a client's name into the client pin itself and watch its roots grow.

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ ⌐▫ Kinroot                                Who it is for  Tranche 2 and the UK MLR  How we…  [Sign in]│
│ · · · · · · · · · · · · · · · · · · · · · · · · · · · · · · · · · · · · · · · · · · · · · ·│
│ ┌─ pinned slip (after trace) ─┐            ┌────────────────────────────────────┐            │
│ │ ◆ Review  Enhanced due dil. │            │ Client │ Bellmere Holdings Pty Ltd [Trace]│     │
│ │ One owner found. One gap…   │            └─────────────────┬──────────────────┘            │
│ │ ① Margaret Calder owns 49.6%│                         ■ AU   ACN 614 203 778 · NSW         │
│ │ ② 38% sits with Halyard…    │              Director ╱  62% ║  ╲ 38%                         │
│ │ ③ Halyard's director…       │              ○ Daniel   ■ Calder Nominees   ■ VG Halyard ②    │
│ │ Next: ask for… Open dossier→│                   80% ╱      ╲ 20%     ?% ┆   ╲ Director      │
│ └─────────────────────────────┘         ■ Calder Inv.   ◰ Wattle St   ⬚ ?Unknown   ○ Peter ③   │
│ Client due diligence for law firms…        100% ║          ┆ Appointor           ┆ Directs     │
│ See who is really                          ● MC ①       ○ Tom Calder          ⬚ 41 companies  │
│ behind your client.                      [100% × 80% × 62% = 49.6% · beneficial owner]       │
│ Type a client's name. Kinroot follows…                                                       │
│ [⟋ Trace a client]  Open Harbourline's files →                                               │
│ ───────────────────────────────────────────                                                  │
│ Designed to support the AML/CTF Act 2006 and the UK MLR 2017. Tranche 2 obligations start in N days. │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Sequence (about 4.5 s, offline seeded data):**
1. 0.0 s: the board, a dot grid, the client pin (empty) hanging from a field: `Client │ Type a client's name ▍`. Three chips under the pin: *Or try: Trust over a company · Circular holding · Nominee directors*.
2. 0.5 s: "Bellmere Holdings Pty Ltd" types itself in (38 ms per character); the ACN appears beside the pin.
3. **Unfold** hop 1 → 2 → 3 (620 ms each, 90 ms gap): owners spring down out of their parent.
4. **Pull the thread:** a slack red string tightens from Margaret Calder up to the client; a knot travels up it while the tag multiplies (100% → 80% → 49.6%).
5. The **slip** pins itself top-left with three numbered reasons; matching numbered badges appear on the nodes they refer to.

Any chip replays the trace with another seeded structure (a trust over a company; a circular holding where the loop is drawn as a ring with "circular: 30% ↺"; a nominee cluster).

Below the fold (paper band, white): **"Three people sign off on a client. Each sees the part they need."**, three ruled columns for fee earners, compliance officers and partners → **"Built for Tranche 2 and the UK MLR 2017"** (obligation-by-obligation, "designed to support", never "certified") → **"How we keep files safe"** (Australian data residency note, tamper-evident activity log, restricted reports, 7-year retention) → a closing board strip with the same field: "Trace a client".

CTAs: primary **Trace a client**; secondary link **Open Harbourline's files →** (signs into the seeded firm). No "Explore the demo", no "Create an account" pair, no stat strip.

## 5. Home: the client constellation (`/board`)

The whole client book as **one clustered network**. Each client is a pin (shape by client type), sized by structure complexity (number of layers and parties), and edged by risk with glyph + colour. Clients that share an officer, owner or address are joined by faint tinted lines and cluster together (ForceAtlas2 in a web worker; positions cached per firm).

```
┌────┬─────────────────────────────────────────────────────────────────────────────────────────┐
│    │ ┌ file tray ─────────────────────────────────────────────────────────────────────────┐  │
│    │ │ 4 waiting for you │Sign off: Calder Family Trust│Match: J. Reyes ×2│Alert: Halyard…│▸ │  │
│    │ └───────────────────────────────────────────────────────────────────────────────────┘  │
│    │                    ◆□        ●○                                                         │
│    │        ●□  ●□ ─ ─ ─ ◆□   (cluster: "share director Peter Voss · 5 clients")   ●□  ●○    │
│    │           ●○      ▲□╌╌╌▲◰                                                    ●□        │
│    │   ●□  ●□      ●◰          ●□   ●○     ◆□ ⌐review due tag                        ●○     │
│    │        ●○  ●□                    ●□        ●□    ●○                                    │
│    │                                                                                         │
│    │ [+ − ⤢][minimap]   Lens: (Risk) Review due  Shared officers  Screening    31 clients    │
└────┴─────────────────────────────────────────────────────────────────────────────────────────┘
```

- **File tray** across the top: 3–6 slips for the signed-in person's next decisions; the caption carries the count ("4 waiting for you"). Slips are paper, 2 px radius, with an oxblood underline on the focused one.
- **Lenses** (bottom bar): Risk (default) · Review due · Shared officers · Screening. Each lens recolours or re-tags pins and puts a one-line caption at the cluster ("5 clients share director Peter Voss"); clicking a caption selects those pins.
- **Review-due tags**: a small paper tag hanging off the pin ("Review 3 Mar").
- Clicking a pin flies the camera to it (450 ms) and unfolds its structure in place; the dossier opens.
- No greeting, no KPI cards, no stat strip; counts appear only as captions.

## 6. Pages and wireframes

Routes: `/` · `/sign-in` · `/board` · `/clients` · `/clients/:id/:tab` · `/onboard` · `/fuse` · `/screening` · `/alerts` · `/reports` · `/reports/:id` · `/ask` · `/programme` · `/activity` · `/settings/:section` · `/settings/members`.

### 6.1 Sign-in (`/sign-in`)
A single dossier card on the board; the Harbourline constellation sits behind, blurred 2 px and dimmed to 40%.
```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ⌐▫ Kinroot                                               · · ·○· · ·■· · · · │
│ · · · ·□· · · · · ·○· · · ┌⌐Sign in┐────────────────────┐ · ·□· · · ·○· · · · │
│ · · ○· · · · ·□· · · · ·  │                            │· · · · ·◰· · · · ·  │
│ · · · · ·◆· · · · · · ·   │ Sign in to your firm's files│ · · ·○· · · · · ·  │
│ · ·□· · · · · ○· · · ·    │ Email      [_____________] │ · ·□· · · · · · ·   │
│ · · · · ·□· · · · · · ·   │ Password   [_____________] │ · · · ·○· · · · ·   │
│ · · ○· · · · · · · ·□·    │ [Sign in]  Email me a link │ · · · · · · · · ·   │
│ · · · · · · ·○· · · · ·   │ ────────────────────────── │ · · ·□· · · · · ·   │
│ · ·□· · · · · · · ·○· ·   │ Open Harbourline's files → │ · · · · · · · · ·   │
│ · · · · · ○· · · · · · ·  │ Sample firm · sample data  │ ·○· · · · · · · ·   │
│ · · · · · · · · · · · · · └────────────────────────────┘ · · · · · · · · · · │
└──────────────────────────────────────────────────────────────────────────────┘
```
Title in Spectral 24; errors appear as a rule-lined note under the field ("That email and password don't match. 3 tries left before a 10-minute pause.").

### 6.2 Client book (`/clients`)
A paper **index sheet** slides from the spine (640 px); the board on the right shows only the clients in the current filter.
```
┌────┬──────────────────────────────────────────────┬──────────────────────────────────┐
│    │ Clients · 31        [Find a client     ] [+ Onboard a client]                    │
│    │ Needs you (4) · In review (6) · Clear (19) · Exited (2)       Sort: Next review ▾ │
│    │ ─────────────────────────────────────────────┤        ●□                        │
│    │ ◆ Review  Bellmere Holdings Pty Ltd   ⊢┬┬    │   ◆□╌╌╌▲◰    (filtered board:     │
│    │           Company · NSW · A. Nguyen   3 layers   ●○        Needs you + In review)│
│    │           Sign-off needed · EDD 1/3     Review 3 Mar 2027                        │
│    │ ─────────────────────────────────────────────┤                                  │
│    │ ▲ High    Calder Family Trust          ⊢┬┬┬   │       ◆□                        │
│    │           Trust · VIC · R. Shah       4 layers                                  │
│    │           Possible sanctions match      Review now                              │
│    │ ─────────────────────────────────────────────┤                                  │
│    │ ● Clear   Okafor & Daughters           ⊢┬     │                                  │
│    │           Partnership · NSW            1 layer                                  │
└────┴──────────────────────────────────────────────┴──────────────────────────────────┘
```
Rows are ledger lines (no zebra, no cards). Client names in Spectral 17; a **structure glyph** (a tiny root diagram, ≤ 40 px) shows depth at a glance. Risk is glyph + word + colour. Click → camera flies to the pin; dossier opens.

### 6.3 Client dossier (`/clients/:id/:tab`) — prototyped (`dossier.html`)
Board: the client's structure (roots down), the red string to each beneficial owner, the As at / Compared with stamp, and "+ New since 3 Mar" tags for changes after onboarding. Drawer tabs: **Summary · Owners · Screening · Risk · Documents · Timeline** (and, for the compliance officer only, a hatched **Restricted** tab when a report exists; nobody else sees that the tab exists).
```
┌────┬───────────────────────────────────────────────┬───────────────────────────────────────┐
│    │[As at 14 Nov│Compared with 3 Mar · onboarding] │⌐Summary┐Owners 3┐Screening 1┐Risk┐Docs 6┐Timeline┐
│    │            (⌕ Find a person, company or trust /)│ Client dossier · HL-2026-0142 · Fee earner A. Nguyen  📌 ✕│
│    │        ⌐■ Bellmere Holdings Pty Ltd             │ Bellmere Holdings Pty Ltd           (Spectral 30) │
│    │  Director╱  62%║   ╲38%                          │ ACN 614 203 778 · Company · NSW · Onboarded 3 Mar │
│    │  ○ Daniel   ■ Calder Nominees   ■ Halyard (VG)  │ ◆ Review  Enhanced due diligence open            │
│    │       80%╱   ╲20%   ?%┆    ╲ Director           │ Beneficial owners        25% or more, or control │
│    │  ■ Calder Inv.  ◰ Wattle   ⬚ ?    ○ Peter Voss  │ ┃Margaret Calder   via Calder Inv.→Nominees 49.6% ● ID verified│
│    │   100%║        ┆Appointor   ▲41 dormant  +New  │  Daniel Okoro     controls as director     —   ● ID verified│
│    │  ● Margaret  ○ Tom          ⬚ 41 companies      │  Not yet known    owners of Halyard (BVI) ≤38% ◆ Ask client │
│    │ [100% × 80% × 62% = 49.6%]                     │ Why this client is rated Review         54 / 100 │
│    │                                                │ 1 38% is held offshore by a company… E-07   +20 │
│    │                                                │ 2 Halyard's director also directs 41… E-11 +15 │
│    │ [+−⤢][⟋◎][minimap]  [○ ■ ◰ — ┄ ━ legend]       │ Risk method v3.2 · Second opinion: Review (agrees)│
│    │                                                │ ┌Compliance officer sign-off ▬▭▭ 1 of 3 ───────┐│
│    │                                                │ │[Request from client] [Sign off (disabled)]   ││
└────┴───────────────────────────────────────────────┴───────────────────────────────────────┘
```
- **Owners tab** = the ledger twin of the graph: every party, how it connects, share, control role, ID status, PEP/sanctions status, source and date of each edge (`E-07 · ASIC extract 3 Mar`).
- **Screening tab**: one row per screened party and list (sanctions lists, PEP lists, adverse-media placeholder) with the result as glyph + word, last screened date, next re-screen.
- **Risk tab**: the full reason list with points, the methodology version, the **second opinion** (the gradient-boosted challenger, worded "Second opinion: Review (agrees)" or "Second opinion: High (disagrees) — sent to review"), and the EDD triggers that fired. Sign-off lives here and on Summary.
- **Documents tab**: identity documents and registers as paper rows with a file glyph, "verified by / on", expiry; drag-and-drop upload area with a dashed outline.
- **Timeline tab**: dated events, newest first, each linked to the edge or decision it changed; ruled list with Red Hat Mono dates down the left margin.

### 6.4 Onboarding wizard (`/onboard`)
The form lives in the drawer; **the board builds the structure live** as owners are added (each new party unfolds under the pin). Steps are folder tabs, not a stepper bar.
```
┌────┬───────────────────────────────────────────────┬──────────────────────────────────────┐
│    │                                               │⌐1 Client┐2 People and owners┐3 Identity┐4 Consent┐5 Review┐
│    │            ⌐■ Wharf Street Property Trust     │ Who owns or controls the trust?      │
│    │             ┆Trustee   ┆Appointor             │ ┌─ ◰ Pyrmont Wharf Pty Ltd  trustee ─┐│
│    │            ■ Pyrmont   ○ Jonathon Reyes        │ └────────────────────────────────────┘│
│    │            Wharf        ⌐possible duplicate↗  │ ┌─ ○ Jonathon Reyes  appointor ──────┐│
│    │                                               │ │ Looks like a person already on file │
│    │            ⬚ + add owner (ghost node)          │ │ (87 in 100). [Review the match]     │
│    │                                               │ └────────────────────────────────────┘│
│    │                                               │ [+ Add a person] [+ Add a company or trust]│
│    │                                               │ Or [Send the client a link to fill this in]│
│    │                                               │                      [Back] [Continue →] │
└────┴───────────────────────────────────────────────┴──────────────────────────────────────┘
```
Client types: individual, company, trust, partnership. Identity step: safe-harbour style checklist (document type, number, verified against issuer: mocked), with "verified" stamps. Consent step: Privacy Act 1988 collection notice and checkbox. Review step: the trace runs once and shows the first rating with reasons before the file is created.

### 6.5 Fuse or split queue (`/fuse`) — prototyped (`fuse.html`)
```
┌────┬───────────────────────────────────────────────┬──────────────────────────────────────┐
│    │7 possible │J.P. Reyes · Jonathon R.│Halyard Ltd · Limited│M. Calder · Margaret A.│+4│ ⌐Match file┐Record A┐Record B┐Past decisions 12┐
│    │duplicates  87 in 100 · person ‾‾‾‾‾  93 · company     81 · person │ Possible duplicate · 1 of 7 · found while onboarding…│
│    │✥ Drag one record onto the other to fuse, or decide…│ Jonathan P. Reyes and Jonathon Reyes │
│    │ ⌐■ Bellmere                    ⌐◰ Wharf Street     │ Probably the same person. Both records… (Spectral) │
│    │   62%│                            ┆Appointor      │ [Kept apart │ You decide      ┃87 │✓]  │
│    │ ■ Calder Nominees                 ┆               │  below 40      40–95            95+   │
│    │   Director┆        ┌87 in 100┐    ┆               │ Field     Record A     Record B   Effect │
│    │ Jonathan P. Reyes ◎╳╳╳╳(JR)╳╳╳╳◎ Jonathon Reyes    │ Birth date 14 Feb 1971 14 Feb 1971 = ▬▬▬ │
│    │ Record A · from Bellmere      Record B · new      │ Address   12 Wharf St… 12 Wharf Street = ▬▬ │
│    │        15% ╲               ╱ Director             │ Name      Jonathan P.  Jonathon    ≈ ▬  │
│    │             ■ Pyrmont Wharf Pty Ltd · linked to both│ ID        Passport ··4471 Not provided — │
│    │ [+−⤢][⑂ ◎]                                       │ [Fuse into one person] [Keep apart] [Reason…]│
└────┴───────────────────────────────────────────────┴──────────────────────────────────────┘
```
The likelihood scale shows **why** a person must decide: below 40 kept apart automatically, 95+ fused automatically, between is "You decide". The Effect column is a plain-language verdict glyph (`=` same, `≈` similar, `≠` different, `—` can't compare) plus a bar pushing towards "same" (right, ink) or "different" (left, grey), which is the SHAP contribution, never shown as a number. **Split** works from any fused node: the Record A / Record B tabs show the originals, and "Split into two" unpicks the stitch.

### 6.6 Screening review (`/screening`)
Queue in the tray; the board shows the screened party with the list entry hanging off it as a **foreign card** (dashed outline, list badge) joined by a dotted "possible match" seam.
```
┌────┬───────────────────────────────────────────────┬──────────────────────────────────────┐
│    │3 to review │Peter Voss · UK sanctions list│Margaret Calder · PEP│…│ ⌐Match┐Party┐List entry┐History┐
│    │                                               │ Possible sanctions match              │
│    │      ■ Halyard Capital Ltd                    │ Peter Voss  ·  UK sanctions list entry │
│    │            ┆ Director                         │ ◆ Review   72 in 100                  │
│    │      ○ Peter Voss ┄┄┄┄┄┄┄┄ ⬚ "VOSS, Pieter"   │ Field      Our record   List entry    │
│    │      Director       possible   UK sanctions   │ Name       Peter Voss   VOSS, Pieter   ≈ │
│    │                     match      list · 2019    │ Born       12 Jun 1968  1968           = │
│    │                                               │ Nationality —           Dutch          — │
│    │                                               │ [True match] [Not a match]            │
│    │                                               │ Reason (required): [___________]      │
│    │                                               │ A true match freezes the matter and   │
│    │                                               │ notifies the compliance officer.      │
└────┴───────────────────────────────────────────────┴──────────────────────────────────────┘
```
Lists: OpenSanctions subsets (sanctions, PEP); adverse media is a placeholder row ("Not checked yet: no source connected").

### 6.7 Monitoring alerts (`/alerts`)
Alerts are grouped per client. Selecting one switches the board into the **before/after overlay** for that client: edges added since the compare date carry a `+ New since <date>` tag, removed edges fade to 35% and turn dashed with `– Removed <date>`.
```
┌────┬───────────────────────────────────────────────┬──────────────────────────────────────┐
│    │5 new │Halyard: new director│Calder Trust: list update│Okafor: review due│… │ ⌐Alert┐What changed┐Actions┐
│    │[As at 14 Nov │ Compared with 3 Mar]           │ New director at Halyard Capital Ltd  │
│    │       ■ Halyard Capital Ltd                    │ Peter Voss appointed 2 Sep · source:  │
│    │      ╱┆ Director  + New since 3 Mar           │ BVI register extract                  │
│    │ ○ Ana Ruiz (35%, dashed)   ○ Peter Voss        │ Affects: Bellmere Holdings (38% owner)│
│    │   – Removed 2 Sep           ▲ 41 dormant cos   │ Suggested: re-rate the client         │
│    │                                               │ [Re-rate Bellmere] [Ask the client]   │
│    │                                               │ [Dismiss…] (reason required)          │
└────┴───────────────────────────────────────────────┴──────────────────────────────────────┘
```
Sources of alerts: list updates (re-screen), register changes, periodic review due, document expiry.

### 6.8 Suspicious-matter report cases (`/reports`, `/reports/:id`) — restricted
Only the compliance officer and named delegates see this route or the rail icon. Everyone else gets the same generic "This page isn't available to you" for restricted, missing and forbidden ids, so nothing reveals that a report exists (tipping-off control). The whole route uses the **restricted** surface: a 135° hatch on the canvas edges and a lock in the header.
```
┌────┬───────────────────────────────────────────────┬──────────────────────────────────────┐
│    │▨▨ Restricted · visible to Priya Raman and 1 delegate · do not discuss with the client ▨▨│
│    │ Cases (2)                                     │ ⌐Grounds┐Evidence 4┐Draft report┐Access┐
│    │ ─────────────────────────────────────────────│ SMR-2026-003 · Calder Family Trust    │
│    │ 🔒 SMR-2026-003  Calder Family Trust          │ ▲ Due in 2 business days (3-day limit)│
│    │    Draft · due in 2 business days             │ Grounds (Spectral)                    │
│    │ 🔒 SMR-2026-002  (filed) Ref AUS-…            │ Funds routed through 3 trusts in 9 days…│
│    │                                               │ Evidence pinned from the board:       │
│    │   board: the case's pinned edges only,        │  E-21 ◰ Calder Family Trust → ■ …     │
│    │   everything else hidden                      │ [Export for AUSTRAC] [Mark as filed…] │
└────┴───────────────────────────────────────────────┴──────────────────────────────────────┘
```
The deadline chip is computed at runtime (AU: 3 business days; 24 hours for terrorism financing). Exports are drafts for the firm to lodge; Kinroot never claims to lodge on the firm's behalf. People without access who meet a restricted field elsewhere (e.g. an auditor in the activity log) see the **Redact** treatment: black bars and a lock, no content.

### 6.9 Ask the board (`/ask`) — the investigation assistant
Not a chat column. Questions are **lines of enquiry**: a slip at the bottom-centre of the board. The answer draws its path on the board in red string with numbered edge citations, and the drawer holds the written answer with the same numbers.
```
┌────┬───────────────────────────────────────────────┬──────────────────────────────────────┐
│    │ Enquiries │Who controls Bellmere?│How is Peter Voss linked to our clients?│…│ ⌐Answer┐Edges used 5┐
│    │                                               │ How is Peter Voss linked to our       │
│    │   ⌐■ Bellmere      ⌐◰ Calder Family Trust      │ clients?                              │
│    │      ╲38% [1]          ╲ Director [4]          │ Peter Voss reaches two clients. He    │
│    │       ■ Halyard ──[2]── ○ Peter Voss ━━[3]━━ ■  │ directs Halyard Capital Ltd [2], which│
│    │                                               │ owns 38% of Bellmere [1], and he is a │
│    │                                               │ director of Kestrel Nominees [3],     │
│    │                                               │ trustee of the Calder Family Trust [4].│
│    │  ┌──────────────────────────────────────────┐ │ Edges used: [1] E-07 … [2] E-11 …     │
│    │  │ Ask about a person, company or trust…  ↵ │ │ [Pin to Bellmere's dossier] [Copy]    │
│    │  └──────────────────────────────────────────┘ │                                       │
│    │   Try: Who controls… · What changed for… since…│                                       │
└────┴───────────────────────────────────────────────┴──────────────────────────────────────┘
```
Answers only ever come from traced paths; if no path exists the answer says "No connection found within 6 steps." Every answer can be pinned to a dossier (it goes into the Timeline with the edges cited).

### 6.10 Compliance programme (`/programme`)
A paper sheet, printable, organised by **obligation**, with numbers inside sentences instead of KPI cards. The board on the right shows the clients the selected row refers to.
```
┌────┬──────────────────────────────────────────────────────────────┬───────────────────────┐
│    │ Compliance programme · Harbourline Legal (Sydney)  [Print brief]│  ▲□ ◆□               │
│    │ Partners' brief (Spectral, 3 sentences)                      │      ◆◰    (filtered) │
│    │ "Two clients are high risk and one sanctions match is open…" │                       │
│    │ ══════════════════════════════════════════════════════════════│                       │
│    │ Customer due diligence   27 of 31 clients complete. 4 waiting │  ▸                    │
│    │                          for identity documents.     Owner PR │                       │
│    │ Ongoing monitoring       5 alerts open, oldest 6 days.        │                       │
│    │ Periodic reviews         3 overdue ▲, 7 due in 30 days ◆      │                       │
│    │ Screening                3 matches waiting, 1 possible sanctions│                     │
│    │ Reporting                1 report in draft (restricted count)  │                       │
│    │ Record keeping           All records within the 7-year rule ● │                       │
│    │ Training                 9 of 11 staff trained this year ◆    │                       │
│    │ Risk method              v3.2 approved; second opinion agrees │                       │
│    │                          on 94% of clients this quarter       │                       │
│    │ Clients by rating   ●●●●●●●●●●●●●●●●●●● ◆◆◆◆◆◆◆◆ ▲▲  (glyph strip, not a chart card) │
└────┴──────────────────────────────────────────────────────────────┴───────────────────────┘
```
The reporting row shows a count only to people who can see reports; for others the row reads "Handled by the compliance officer".

### 6.11 Activity log (`/activity`)
A ledger sheet. Every row is sealed (hash-chained); the seal column shows a short hash and a chain-link glyph. **Verify the chain** walks the seals row by row.
```
┌────┬──────────────────────────────────────────────────────────────────────────────────────┐
│    │ Activity log   [Person ▾][Client ▾][Action ▾][Dates ▾]              [Verify the chain] │
│    │ When (mono)        Who            What                                         Seal    │
│    │ 14 Nov 10:42       Priya Raman    Fused Jonathan P. Reyes and Jonathon Reyes   ⛓ 9f3a…│
│    │ 14 Nov 10:31       Alex Nguyen    Requested documents from Bellmere Holdings   ⛓ 21c0…│
│    │ 14 Nov 09:58       ▇▇▇▇▇▇▇▇       ▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇ 🔒 Restricted entry      ⛓ 7be2…│
│    │ 13 Nov 16:20       Priya Raman    Signed off Okafor & Daughters · ● Clear      ⛓ 0d11…│
│    │ ── Chain verified: 1,284 entries, unbroken ●                                          │
└────┴──────────────────────────────────────────────────────────────────────────────────────┘
```

### 6.12 Settings (`/settings/:section`) and members (`/settings/members`)
A paper sheet with folder tabs along its top: **Firm · Members · Risk method · Screening lists · Retention · Notifications**.
```
┌────┬──────────────────────────────────────────────────────────────────────────────────────┐
│    │ ⌐Firm┐Members 11┐Risk method┐Screening lists┐Retention┐Notifications┐                   │
│    │ Members                                         [Invite someone]                      │
│    │ Name            Role                 Can see reports   Last active   ⋯                │
│    │ Priya Raman     Compliance officer   🔒 Yes            today                          │
│    │ Alex Nguyen     Fee earner           —                 today                          │
│    │ Grace Liu       Partner              —                 2 days ago                     │
│    │ M. Ferreira     Auditor (read only)  —                 invited · expires in 6 days    │
│    │ ─ Pending invitations (1) ─                                                           │
│    │ Firm tab: name, jurisdiction (Australia / United Kingdom), data stored in Australia   │
│    │ (Sydney), compliance officer, firm stamp. Retention tab: 7 years after the client     │
│    │ relationship ends (AU) / 5 years (UK MLR), with the deletion queue.                   │
└────┴──────────────────────────────────────────────────────────────────────────────────────┘
```
Risk method tab: versions as a ruled list (v3.2 current, v3.1 retired) with weights, thresholds (Clear < 35 ≤ Review < 70 ≤ High), EDD triggers, and "Second opinion" settings (disagreements go to review; the rules stay the decision of record).

## 7. Type

| Role | Face | Size / line | Weight | Use |
|---|---|---|---|---|
| Display | Spectral | 50 / 52 (landing only; 40 at 768 px, 34 at 390 px) | 500, italic 500 for one emphasised word | Landing headline |
| Title | Spectral | 30 / 34 | 500 | Dossier and match-file titles |
| Heading | Spectral | 21–24 / 28 | 500 | Slip titles, sign-off box, section leads |
| Reason | Spectral | 15.5–16 / 24 | 400 | Reasons, answers, partners' brief, any "why" sentence |
| UI | Hanken Grotesk | 14 / 21 | 400 / 600 | Body, buttons (600), nav |
| Label | Hanken Grotesk | 12–13 / 16 | 600 | Section heads, column heads, chips. **Sentence case, never tracked caps.** |
| Small | Hanken Grotesk | 11.5–12 / 16 | 400–500 | Hints, captions |
| Data | Red Hat Mono | 11–13 / 16 | 400–600, tabular | ACN/ABN/company numbers, %, dates, scores, hashes, edge ids |

Fonts: Google Fonts `Spectral:ital,wght@0,400;0,500;0,600;1,400;1,500`, `Hanken+Grotesk:wght@400;500;600;700`, `Red+Hat+Mono:wght@400;500;600` (self-host with `@fontsource` packages in the build). Rule: **Spectral speaks, Hanken works, Red Hat Mono counts.** Mono is never used for labels or nav (that is Plotline's voice).

## 8. Palette (tokens)

Light is the default; dark is a full theme (not an inversion). The spine is ink-black in both.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--canvas` | `#E8EBEA` | `#101315` | Board (bond grey), with a 1 px dot grid every 22 px |
| `--dot` | `#BFC6C4` | `#262D31` | Dot grid |
| `--paper` | `#FFFFFF` | `#191D20` | Dossier, slips, cards |
| `--paper-2` | `#F5F6F5` | `#1F2427` | Quiet fills, hover |
| `--paper-edge` | `#D3D8D6` | `#2C3337` | Hairline around paper |
| `--rule` | `#DDE1DF` | `#2A3034` | Ledger rules |
| `--rule-strong` | `#A7AFAD` | `#4A5357` | Input borders, secondary buttons |
| `--ink` | `#15181B` | `#E7EAEA` | Text, node outlines |
| `--ink-2` | `#353B40` | `#C5CBCC` | Secondary text, ownership edges |
| `--muted` | `#586064` | `#98A1A4` | Captions (AA on canvas and paper) |
| `--faint` | `#7D8588` | `#7A8387` | Glyphs, disabled, dotted edges only (≥ 3:1, **not for body text**) |
| `--spine` | `#15181B` | `#08090A` | Rail |
| `--string` | `#9B1C31` | `#E35D71` | **Oxblood red string**, primary buttons, focus ring, UBO |
| `--string-hover` | `#7E1527` | `#EE7F8F` | |
| `--string-tint` | `#F5E3E6` | `#3A1C22` | Ghost fuse node, high-risk chip fill |
| `--on-string` | `#FFFFFF` | `#170A0D` | Text on oxblood |
| `--clear` / tint | `#2F6B4F` / `#E3EFE8` | `#6CC29A` / `#183026` | ● Clear |
| `--review` / tint | `#8A6100` / `#F6ECD3` | `#E3B24F` / `#352A12` | ◆ Review |
| `--high` / tint | `#9B1C31` / `#F5E3E6` | `#E35D71` / `#3A1C22` | ▲ High |
| `--restricted` | `#2B2F33` on 135° hatch | `#C7CCD0` on hatch | 🔒 Restricted |
| `--edge-own` | `#3A4146` | `#AEB6B9` | Ownership edges |
| `--edge-ctrl` | `#6B7377` | `#858E92` | Control edges |
| `--edge-faint` | `#B9C0BE` | `#3A4246` | Constellation links, minimap |

Hue family: oxblood ≈ 350°, unique in the portfolio. **No orange anywhere** (Plotline). No gradients except the hatch. Shadows: `--shadow-paper` (three-layer soft paper shadow) and `--shadow-drawer` (left-cast).

## 9. Status language (never colour alone)

| Status | Glyph | Word | Colour | Where |
|---|---|---|---|---|
| Clear | ● | "Clear" / "ID verified" | `--clear` on tint | ratings, IDs, screening |
| Review | ◆ | "Review" / "Ask client" | `--review` on tint | ratings, EDD, possible matches |
| High | ▲ | "High" / "Possible sanctions match" | `--high` on tint | ratings, hits |
| Restricted | 🔒 + hatch | "Restricted" | `--restricted` on hatch | SMR, redacted rows |
| Unknown | ? in dashed outline | "Not yet known" | `--muted` | owners, % |
| New since | + in dashed tag | "New since 3 Mar" | ink on paper | before/after overlay |
| Removed | – with 35% opacity | "Removed 2 Sep" | ink at 35% | before/after overlay |
| Beneficial owner | filled oxblood shape + double ring + string | "Beneficial owner · 49.6%" | `--string` | graph, owners ledger (oxblood bar at row start) |

Chips: 2 px radius, 12 px Hanken 600, glyph first. Match likelihood is always "87 in 100", never "0.87" or "87% confidence".

## 10. Shape language

- **Radius 2 px everywhere** (paper, not pills). The only round things: person nodes, the Find pill, the firm stamp, count badges.
- Paper surfaces: 1 px `--paper-edge` hairline + `--shadow-paper`. Ledgers: 1 px rules, no zebra, no row cards.
- **Notched folder tabs**: 34 px tall (active 38 px and raised 4 px), corners clipped 6 px, sitting on the board above the paper.
- **Slips** (tray items, pinned notes): paper, 2 px radius, an oxblood pin dot on pinned ones, an oxblood 2 px underline on the active one.
- Sign-off box: 1 px ink border with an inner 1 px rule inset 3 px (a document frame), checks as three short bars.
- Buttons: 38 px, 2 px radius. Primary = oxblood fill; "ink" = ink fill for neutral strong actions; secondary = paper with `--rule-strong` border; text links are ink with a 1.5 px oxblood underline offset 4 px.
- Focus: 2 px canvas gap + 2 px oxblood ring on everything focusable, including graph nodes.
- Density: medium; 8 px base grid; drawer padding 26/30.
- Logo: wordmark "Kinroot" in Spectral italic 500 with a glyph: a small square (company) whose oxblood thread, knotted once, runs down to a circle (person).

## 11. Graph styling spec

**Layout:** structure views use a layered **roots-down** layout (client at the top, owners beneath; dagre/ELK layered, rank separation 160 px, node separation ≥ 205 px so labels never collide). The constellation uses ForceAtlas2 (web worker, ≤ 1.5 s, then frozen and cached). Labels sit **to the right** of the shape (max width 146 px, two lines), so incoming arrows from below never cross them.

**Nodes** (BOVS-derived):

| Party | Shape (38 px; client 46 px) | Inside | Notes |
|---|---|---|---|
| Person | circle, 1.5 px ink outline, paper fill | initials, Hanken 600 12 | PEP: small "PEP" badge top-right |
| Company | square, radius 2 | ISO country code, Red Hat Mono 600 11 (AU, GB, VG) | listed company: a 2 px bar under the square |
| Trust / arrangement | square with an 11 px folded top-right corner | "T" | trustee and appointor drawn as control edges |
| Partnership | square split by a vertical rule | "P" | |
| Unknown party | dashed outline | "?" in Spectral | label "Unknown shareholders · 1 or more" |
| Stack (many similar) | dotted outline with an offset copy behind | count | "41 companies · Dormant"; opens into its members |
| Client | 46 px, 2.5 px border, **oxblood pin dot** above | as type | |
| Beneficial owner | shape filled oxblood, 4 px canvas gap + 1.5 px oxblood ring | white initials | name in oxblood; sub "Beneficial owner · 49.6%" |
| Selected | 4 px canvas gap + 1.5 px ink ring | | |
| Dimmed (not a neighbour of hover/focus) | 35% opacity | | |

**Edges** (arrow from the interested party to the subject; arrowheads always drawn):

| Relationship | Style | Label |
|---|---|---|
| Owns | solid 1.6 px `--edge-own`, arrowhead 4.2× thickness | "62%" in Red Hat Mono 11, on a canvas-coloured pill at the midpoint |
| Controls (director, appointor, trustee, nominee, signatory) | dashed 6/4, 1.5 px `--edge-ctrl` | role in Hanken italic 11.5 ("Director") |
| Unknown interest | dotted 2/4, `--faint` | "?%" |
| Range | solid | "10–15%" |
| Indirect / compounded | only ever shown by the red string | tag "100% × 80% × 62% = 49.6%" |
| Shared address / shared officer (constellation) | 1 px `--edge-faint`, no arrow | caption on hover only |
| Added since compare date | normal style + "+ New since …" tag | |
| Removed since compare date | dashed, 35% opacity + "– Removed …" tag | |
| Circular holding | edge curves back (`EdgeCurveProgram`), loop tag "Circular · 30% ↺" | |

**The red string:** 3 px `--string`, round caps and joins, over a 9 px `--canvas` underlay so it reads above other edges; the edges it covers hand their labels over (labels turn oxblood with white text). One active string at a time; "Pull the thread" on a person shows all of their paths, the strongest at full weight and the others at 1.5 px / 50%. The compounded-% tag hangs under the owner's node.

**Threshold:** ≥ 25% ownership (AU and UK) or any control role makes a beneficial owner; the threshold value lives in the risk method settings.

**Rendering (validated in the prototype):** Sigma 3 owns the camera, the layout coordinate space (`setCustomBBox` so unfolding never rescales the view), hit-testing and the WebGL edges for ownership (`createEdgeArrowProgram({ lengthToThicknessRatio: 4.2, widenessToThicknessRatio: 3.4 })`); nodes are drawn transparent in WebGL at their real radius so arrowheads stop at the shape. An **evidence layer** (absolutely positioned HTML + one SVG, synced on `afterRender` via `graphToViewport`) draws the node shapes and labels (crisp web fonts, focusable buttons), dashed control edges, edge labels and the red string, which needs dashes, springs and text. The constellation (hundreds of pins) is pure Sigma WebGL with `@sigma/node-border` for risk rings and canvas labels. Pin `sigma@3.0.2` and `graphology@0.26.0` (Sigma 4.0.x was less than two weeks old when this was written; move to it only after it has settled).

Accessibility: every graph has its **ledger twin** (Owners tab / list view) with the same data; nodes are `role="button"` with `aria-label="Margaret Calder, beneficial owner, 49.6 percent through Calder Investments and Calder Nominees"`; arrow keys walk edges; the minimap is `aria-hidden`.

## 12. Motion: "Tracing"

Libraries: Motion for drawer, tabs, tray and layout; Sigma camera `animate` + a small rAF tween for node positions; CSS for small UI. Everything animates transform/opacity (or SVG path data), 60 fps.

| Name | What moves | Duration / easing | Reduced motion |
|---|---|---|---|
| **Unfold** | a layer of owners springs out of its parent: position from parent → slot, scale .6 → 1, opacity 0 → 1 in the first 45% | 620 ms per hop, 90 ms gap between hops; spring stiffness 220, damping 22 (≈ 6% overshoot); edges follow their nodes | structure appears settled at once |
| **Pull the thread** | the string appears **slack** (each segment sags 46 px, alternating sides) and snaps **taut** (damped: `1 − e^(−6t)·cos 9t`); a 6 px knot travels from owner to client; the % tag steps per hop; the owner fills oxblood at the end (180 ms) | 900–1100 ms; knot linear in arc length | string drawn taut, no knot, final equation shown |
| **Fuse** | drag a node: it follows the pointer 1:1; within 64 px of a candidate it is pulled in (spring 400/30) and the seam's cross-stitches appear left to right (12 ms stagger); on confirm both nodes slide to the midpoint, edges re-attach (endpoint tween 300 ms) and the knot pulses once (scale 1 → 1.15 → 1, 240 ms) | 420 ms spring | nodes swap to the fused node instantly; a 120 ms fade |
| **Split** | stitches unpick right to left, the nodes spring apart to their own slots | 480 ms | instant |
| **Redact** | black bars sweep left to right across each restricted field, then the lock fades in | 220 ms per field, 40 ms stagger, `cubic-bezier(.65,0,.35,1)`; lock 120 ms | bars appear at once |
| **Drawer** | dossier slides in from the right while the camera pans to keep the selection in the visible board | 360 ms `cubic-bezier(.32,.72,0,1)`; camera 450 ms quadInOut | 120 ms fade, no pan animation |
| **Folder tab** | active tab rises 4 px; paper content cross-fades (no slide) | 160 ms / 140 ms ease-out | instant |
| **Pin a slip** | slip drops from 10 px above with a 0.6° tilt that settles flat; the pin dot lands last | 600 ms `cubic-bezier(.2,.8,.2,1)` | 120 ms fade |
| **Before/after** | added edges pop their "+" tag (scale .8 → 1, 180 ms); removed edges fade to 35% and turn dashed (300 ms). No scrubbing, no line-drawing reveal. | | static |
| **Seal check** | Verify the chain: each row's chain-link glyph closes (two halves meet, 160 ms) with a 25 ms stagger, then the summary line appears | | summary only |
| **Fly to** | camera to a pin from the constellation | 450 ms quadInOut | jump |

What Kinroot **never** uses: self-drawing outlines with `stroke-dashoffset` or time-ruler scrubs (Plotline), plain 150 ms page fades as the only motion (Necessa), 3D flips, parallax or scroll-jacking.

`prefers-reduced-motion: reduce` switches every row to its right-hand column; the landing renders its settled state (`?still` in the prototype shows exactly that).

## 13. Copy voice

Precise, legal, calm. Short declaratives. Sentence case. No exclamation marks, no "Oops", no emoji in UI. Name the person and the number ("Margaret Calder owns 49.6% through two companies"), then the next step ("Next: ask for Halyard's register of members").

- **Verbs and CTAs:** Trace a client · Open Harbourline's files · Pull the thread · Fuse into one person · Keep apart · Split into two · Sign off · Request from client · Re-rate · Dismiss (with a reason) · Pin to dossier · Export for AUSTRAC · Mark as filed · Verify the chain · Invite someone.
- **The machine-learning parts are described by what they do:** "match likelihood 87 in 100", "second opinion", "pattern check". The rules-based rating is "the risk method".
- **Compliance claims:** "designed to support", "aligned with", "built for the AML/CTF Act 2006 and the UK Money Laundering Regulations 2017". Never "certified", "compliant", "guarantees" or "approved by AUSTRAC/the FCA".
- **Tipping-off:** restricted copy says what to do, not what is inside ("Restricted. Do not discuss this with the client or anyone outside this list."). Error and empty states never reveal whether a restricted record exists.
- **Forbidden in rendered UI (STANDARDS §4):** RAG, retrieval, embeddings, vector, rerank, LLM, model or provider names (GPT, Gemini, Groq, Llama, Claude…), LiteLLM, prompt, tokens, SQL, architecture, pipeline, agent internals, A2A/MCP, latency, fallback, cache. Also avoid for this product: "AI-powered", "smart", "magic", "algorithm", "Cypher", "graph database", "node"/"edge" in user-facing copy (say person, company, trust, link, connection; the citation ids `E-07` stay).
- **Dates and the as-of convention (coordinator rule):** the repo's copy is written as of **mid-October 2025**. Australia's Tranche 2 obligations **"commence 1 July 2026"**; never "are now live", "took effect" or "since July" in hard-coded text. Anything time-sensitive is computed at runtime from today's date: before 1 July 2026, "Tranche 2 obligations start in N days"; from that date, "Tranche 2 obligations in force since 1 July 2026" (see `prototype/index.html`). SMR deadlines, review-due tags, "new this week" and seeded demo dates are relative to today at runtime. Keep all other copy timeless.

## 14. How this differs from Necessa and Plotline

| Dimension | Necessa | Plotline (Field Atlas) | **Kinroot** |
|---|---|---|---|
| Metaphor | Clinical worklist | Field atlas + surveyor's ledger | **Investigation board + case dossiers** |
| App shell | Light left sidebar with org card and grouped text nav, top search | Two-tier masthead with mono caps section tabs over a full-bleed map | **Ink-black 64 px icon spine + infinite graph board + right dossier drawer with folder tabs** |
| Landing | Headline left, product card right, 4-up stat strip | Huge centred serif date over a topographic map, scroll story | **The board itself: type into the client pin, roots grow, red string pulled; headline is a small caption bottom-left** |
| Home | "Good evening, Maya" + Today list + 4 KPI cards | Map of plots with floating ledger and time ruler | **Client constellation: every client a pin, clustered by shared officers, file tray of decisions** |
| Data idiom | Lists and cards with score rings | Map layers, ledger rows, stamped statements | **Graph + ledger twin + reason lists with cited links** |
| Type | System sans | Newsreader serif + IBM Plex Mono caps labels | **Spectral (speaks) + Hanken Grotesk (works) + Red Hat Mono (counts only); sentence-case labels** |
| Palette | Neutral grey + indigo | Warm map paper #ECE7DB + slate + surveyor orange | **Cool bond-grey #E8EBEA dot grid + white paper + oxblood #9B1C31 string; no orange** |
| Shape | 8–12 px radius cards | Square boxes, ruled forms, rubber stamp | **2 px paper, notched folder tabs, pinned slips, BOVS node shapes** |
| Motion | 150 ms fades | Self-drawing outlines, fly-to, time-ruler scrub | **Unfold springs, slack-to-taut string with travelling knot, stitch fuse/unpick, redaction sweep** |
| Signature interactions | Live check progress, quote highlight | Ruler scrub across cut-off, statement stamp | **Pull the thread · Fuse or split · Before/after overlay (date stamp, not a ruler)** |
| CTAs | Explore the demo / Create an account | Open the Northbank atlas / Start your atlas | **Trace a client / Open Harbourline's files** |
| Logo | Indigo app tile "M" | Folded-map glyph + serif wordmark | **Spectral italic wordmark + knotted-thread glyph** |

## 15. Prototype

`prototype/` (static, no build): `kinroot.css` (tokens + shell), `board.js` (Sigma + evidence layer, Unfold and Pull the thread), `index.html` (landing with the type-a-client trace), `dossier.html` (dossier with UBO path), `fuse.html` (match review). CDN libraries are pinned: `graphology@0.26.0`, `sigma@3.0.2`, `lucide@0.469.0`, and Google Fonts. `prototype/shoot.mjs` reproduces the screenshots in `shots/` (1440×900 @2×, light and dark, plus the landing's typing and mid-trace frames).

## 16. Build notes

- **Versions.** The app pins `sigma@3.0.3` (the patch release of the 3.0 line validated in the prototype) and `graphology@0.26.0`; Motion 12 and lucide-react are used for UI motion and icons. Fonts are bundled offline with `@fontsource` (Spectral, Hanken Grotesk, Red Hat Mono).
- **One engine for every board.** `src/graph/engine.ts` is the prototype's `board.js` grown into a class: Sigma owns the camera, a custom bbox fitted to the visible part of the board (drawer and sheets are insets, so opening a drawer pans the view), hit-testing and the WebGL ownership arrows; the HTML/SVG evidence layer draws shapes, labels, dashed control links, tags, citation badges, the fuse seam and the red string. Links that skip a row, and parallel owns/controls pairs, bow so they never cut through a label.
- **Constellation.** With ~30 clients per firm the constellation also uses the evidence layer (focusable pins with rating glyphs and review tags) instead of pure WebGL; ForceAtlas2 runs synchronously from a seeded start, then labels are de-collided. Switch to WebGL pins with `@sigma/node-border` if a book grows past a few hundred clients.
- **Ledger twin.** Wherever WebGL is unavailable (and always for screen readers) the board renders a text version of the same scene; the dossier's Owners tab is the full ledger twin.
- **Data.** `src/api/endpoints.ts` is the typed client for `docs/API_CONTRACT.md`. `VITE_API_MOCK=1` swaps `fetch` for an in-browser fixture adapter (`src/api/mock`) that follows the same contract, including tipping-off 404s; tests use the same adapter. The real API (Vite proxy `/api` → :8020) is the default.
