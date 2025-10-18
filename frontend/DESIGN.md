# Kinroot frontend design: brief and exhibit

> The design was first worked out as a static HTML prototype (not part of this repository) and then revised into the "brief and exhibit" layout described here. The app follows this document for layout, type, colour, components and the graph grammar.

Kinroot is customer due diligence and beneficial-ownership software for Australian law firms, accountants and conveyancers coming under the AML/CTF Act through the Tranche 2 reforms, and for UK firms under the Money Laundering Regulations 2017. The demo firm is **Harbourline Legal (Sydney)**.

Stack: React + Vite + React Router + TanStack Query + Tailwind 4.1 (tokens below go into `@theme inline`), **shadcn/ui** (new-york, Radix primitives through the `radix-ui` package, copied into `src/components/ui/` and re-skinned to the paper tokens), TanStack Table for registers, react-resizable-panels for the binding, cmdk for Find, Sonner for toasts, **Sigma.js 3 + graphology** for the board, Motion for UI motion, lucide-react for icons.

---

## 1. References

Every reference was reviewed before design work began. Where a vendor page is marketing-only, the "take" comes from their documentation or release notes, as noted.

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
| 11 | Cambridge Intelligence KeyLines combos: https://cambridge-intelligence.com/?p=30003 | Combos: group nodes and hide the detail beneath them until opened (detail on demand). → A client pin on the constellation opens into its structure; stacks open into their members. (We do **not** take their time bar: point-in-time views use an "As at / Compared with" date stamp instead of a scrubbing ruler.) |
| 12 | Kumu views: https://docs.kumu.io/guides/views | Several named views over one map, with a toggle control. → Constellation **lenses** (Risk · Review due · Shared officers · Screening). |
| 13 | Obsidian graph view: https://obsidian.md/help/plugins/graph | Local graph with depth, hover dims everything that is not a neighbour, colour groups by query. → Hover/focus on a node dims non-neighbours to 35%; "Focus mode" limits depth. |
| 14 | Sigma.js: https://www.sigmajs.org/ (v3 API) | WebGL rendering for the full client book, camera animation, reducers for highlight/dim, `setCustomBBox` to stop the camera jumping while nodes unfold, `createEdgeArrowProgram` for weighted arrowheads. |
| 15 | tldraw: https://tldraw.dev/ | Canvas chrome: zoom group, minimap, focus mode, floating UI that never covers the work. |
| 16 | Evidence-board web pieces: Framer "Evidence Board" component https://www.framer.com/community/marketplace/components/evidence-board/ , a blockchain-security site with click-a-node dossiers https://contra.com/p/MsoBgWZY-interactive-website-for-blockchain-security-firm , "Itz Confidential" scroll evidence board https://portfolio-website-lake-tau.vercel.app/work/itz-confidential | The pinned slip, the dossier that opens from a node with hop count and risk, and the red thread. **What we avoid:** corkboard textures, noir black, polaroids, handwritten fonts and neon on black. Kinroot is a clean professional board; the string is the only theatrical element. (No Awwwards/Godly piece matched "legal investigation board" closely; this was checked and these were the nearest.) |
| 17 | Hummingbird help centre: https://help.hummingbird.co/llms-full.txt | The "Investigation Canvas": a review's Overview, Research checklist and Actions (narrative, decision, filing) live in one panel, supporting data opens beside it, due dates feed a timeline of urgent cases. → The folio holds the whole record with the decision at its foot; the docket sorts by due date. |
| 18 | Maltego interface and Detail View: https://docs.maltego.com/en/support/solutions/articles/15000059532-navigate-the-interface , https://support.maltego.com/en/support/solutions/articles/15000019236-detail-view | Graph and table views shown together and resizable; the detail list syncs its selection to the graph. → Folio and exhibit side by side with a resizable binding; hovering a register row selects its pin. |
| 19 | i2 Analyst's Notebook (IBM support): https://www.ibm.com/support/pages/setting-event-frame-behaviour-theme-lines-after-importing-ibm-i2-analysts-notebook | List views that centre the chart on the chosen record; timelines built from one line per entity. → Cite and row clicks fly the camera; the dossier Timeline tab. |
| 20 | Linear triage and inbox: https://linear.app/docs/triage , https://linear.app/docs/inbox | Queues worked from the keyboard (J/K to move, one key per decision). → Every queue has a pager ("2 of 4") and `F` / `K` / `J` keys in the decision block. |
| 21 | Persona case layouts: https://help.withpersona.com/articles/71bfAMD6bNyf7zFW7Q1ghk.md | Case pages built from modules including an event timeline, a checklist and a SAR/STR module, with status sequences. → Folder tabs per record; the restricted case file with its draft report. |
| 22 | Middesk review tasks: https://docs.middesk.com/verify-business/name-address/review-tasks | Each check returns Success / Warning / Failure with a short sub-label. → Stamps are glyph + word + tint ("● ID verified", "◆ Ask client"). |
| 23 | Sardine platform updates: https://www.sardine.ai/blog/risk-platform-updates-november-2023 | Every unresolved review for an entity in one queue widget. → The docket gathers sign-offs, matches, duplicates, alerts, reviews and report deadlines in one register. |
| 24 | LexisNexis Bridger Insight XG: https://www.lexisnexis.com.au/riskandcompliance/bridger-insight.aspx | Screening as alert generation, false-positive reduction and human disposition. → Screening review is a reasoned human decision; the reason is required. |
| 25 | Seventh Circuit, "Requirements and Suggestions for Typography in Briefs": https://www.ca7.uscourts.gov/assets/pdf/type.pdf | Names Clarendon among faces for briefs and prefers large x-heights. → Besley for titles and reasons. |
| 26 | Clarendon (typeface): https://en.wikipedia.org/wiki/Clarendon_(typeface) | Robert Besley, 1845, the first type designed as a related bold, the face of notices. → Besley, a Clarendon revival. |
| 27 | Ysabeau (Christian Thalmann): https://github.com/CatharsisFonts/Ysabeau | A humanist sans on Garamond letterforms; the Office cut defaults to tabular lining figures. → The UI face. |
| 28 | Practical Typography, monospaced fonts: https://practicaltypography.com/monospaced-fonts.html | Monospace for code-like strings only. → Sometype Mono only for identifiers and figures. |
| 29 | shadcn/ui on Tailwind v4: https://ui.shadcn.com/docs/tailwind-v4 | Tokens through `@theme inline`, `tw-animate-css`, `data-slot` on every primitive. → The component system and its skin. |

## 2. Metaphor and mental model

**An investigation board with case dossiers.** The compliance officer's question is always the same: *who is really behind this client, and what do I need to check before we act?*

- Every client is a **pin** on the board. Owners, directors, trusts and nominees hang beneath it like **roots** ("Kinroot"): the client sits at the top and its owners grow downward, layer by layer, to the people at the end.
- The path from a person to the client is a **red string**. Pulling it shows how much that person really owns ("100% × 80% × 62% = 49.6%").
- Each client has a **dossier**: a paper file bound beside the board, with folder tabs.
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

## 3. Layout system: brief and exhibit

Every signed-in screen is one working surface, like a legal brief filed with its exhibit bundle: the **folio** (the written record) bound to the **exhibit** (the board). There is no top navbar, no centred column and no right-hand card panel.

```
┌──┬──────────────────────────────┬┬─────────────────────────────────────────────┐
│▣ │ FOLIO (the written record)   ││ EXHIBIT (the board)                         │
│  │ ┌ caption ──────────────────┐││ [Exhibit A · Ownership │ As at │ Compared…] │
│⌕ │ │Client file HL-2291 · …    │││                      [⌕ Find a person… /]   │
│  │ │Harbour Quay Developments  │││ Trail: Ava Calder ━ Calder Family Trust ━ … │
│▤ │ │▲ High  ○ EDD complete …   │││            ■ client                         │
│⑂ │ └───────────────────────────┘││          ╱  │                               │
│⛨ │ ⌐Summary┐Owners┐Screening┐…  ││         ■   ■                               │
│◷ │ [1] Beneficial owners  …     ││         │                                   │
│  │ [2] Why rated High   E-04    ││         ● ← string                          │
│  │ ┌ decision ─────────────────┐││ [+ − ⤢][⟋ ◎][minimap]   [○ ■ ◰ — ┄ ━]     │
│HL│ │ Signed off · Request …    │││                                             │
└──┴──────────────────────────────┴┴─────────────────────────────────────────────┘
 64   folio 36–62 % (resizable)  binding           exhibit
```

- **Spine** (64 px, ink-black in both themes, like the spine of a case binder). Icons only, each with a Radix tooltip and an `aria-label`; the active item gets a 3 px oxblood tab. Order: Find │ Board · Clients · Onboard │ Fuse or split (count) · Screening (count) · Alerts (count) · Reports (lock; compliance officer and delegates only) · Ask the board │ Programme · Activity log … Settings · **firm stamp** (opens the firm switcher, a dropdown menu) · user initials (account menu: theme, sign out).
- **Folio** (left, paper). The record, built from the same four parts on every screen:
  1. **Caption**: a legal file caption. Mono reference line (`Client file HL-2291 · Fee earner Tom Nguyen`), the serif title, a row of stamps, and tools on the right. On queue screens the tools hold the **queue pager** (`‹ 2 of 4 ›`, with the whole queue in a searchable popover).
  2. **Folder tabs**: the notched tabs (Radix Tabs; arrow keys, `[` `]`, Esc back to the board).
  3. **Body**: registers (tables), numbered paragraphs and reason lists. Paragraph numbers sit in the left margin like a judgment: `[1]`, `[2]`.
  4. **Decision block**: sticky at the foot, under a double rule. Buttons, the required reason and the key hints live here, so deciding is always in the same place.
- **Binding**: the resize handle between folio and exhibit, drawn as a stitched seam (oxblood while dragged). Each route asks for a width: `narrow` 36 %, `normal` 44 %, `wide` 60 %, or `full` for records with no exhibit (activity log, settings).
- **Exhibit** (right, the board, always mounted). Labelled like an exhibit, with the As at / Compared with stamp, the **trail** of the last thread pulled (a hop log from the person to the client with the compounded share), a Find trigger, the zoom / thread / focus tools, the minimap and the legend. The exhibit follows the folio: hovering or focusing a register row selects that pin; an `E-07` cite flies to the link.
- **Find** (`/` or `⌘K` anywhere, the spine, or the exhibit trigger): a command palette for people, companies and trusts on the board and every part of the file.
- **Keyboard**: `/` find · `T` pull the thread on the focused node · `F` / `K` / `J` fuse, keep apart, next in the fuse queue · `[` `]` previous/next folder tab · `Esc` back to the board · arrow keys move focus between connected nodes (Tab order follows the ledger twin).
- **Phones (390 px)**: the folio is the screen; a `File | Board` switch at the top shows the exhibit full-screen; the spine becomes a 5-item bottom bar (Board · Clients · Waiting · Ask · More), and More opens a bottom sheet.

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

## 5. Home: the docket and the client book (`/board`)

The folio is **the docket**: a register of every decision waiting on the signed-in person (sign-offs, screening matches, possible duplicates, second-opinion differences, alerts, periodic reviews and, for the compliance officer only, the restricted report clock), sorted by when it is due. The due column is computed at runtime ("Due today", "2 days late", "Due in 2 business days" for a report). The caption carries the count ("7 waiting for you") and a "late" stamp when anything is overdue.

The exhibit is the **client constellation**: the whole client book as one clustered network. Each client is a pin (shape by client type) edged by risk with glyph + colour; clients that share an officer, owner or address are joined by faint lines and cluster together. Hovering a docket row lights its client's pin. **Lenses** (a segmented control at the foot of the exhibit): Risk (default) · Review due · Shared officers · Screening; each recolours or re-tags pins and puts a one-line caption beside the control ("5 clients share director Peter Voss"); the Shared officers lens lists the groups to highlight.

No greeting, no KPI cards, no stat strip; counts appear only in captions.

## 6. Screens

Routes: `/` · `/sign-in` · `/sign-up` · `/invite/:token` · `/board` · `/clients` · `/clients/:id/:tab` · `/onboard` · `/fuse/:id?` · `/screening/:id?` · `/alerts/:id?` · `/reports` · `/reports/:id` · `/ask` · `/programme` · `/activity` · `/settings/:section` · `/waiting` · `/more`.

| Screen | Folio (the record) | Exhibit (the board) |
|---|---|---|
| Sign in | A single file on the blurred constellation: folder tab, mono reference line, fields, "Open Harbourline's files" and one button per demo role | — |
| Docket `/board` | The docket register (see §5) | The constellation with lenses |
| Client book `/clients` | Wide folio. A register (TanStack Table): rating, client (serif name, kind, jurisdiction, fee earner, status line), structure glyph and depth, next review; sortable headers, facet toggles with counts (Needs you · In review · Clear · Onboarding · Exited), search | The constellation dimmed to the clients in the filter; row hover selects the pin |
| Client dossier `/clients/:id/:tab` | Caption (client file reference, name, kind and onboarding date, rating stamp, due diligence stamp, next review). Tabs: Summary (numbered paragraphs: beneficial owners, why rated) · Owners (the ledger twin with sources) · Screening · Risk (every reason, enhanced checks, second opinion, hold, rating by hand in a dialog, earlier ratings) · Documents · Timeline · Restricted (compliance officer only, hatched). Decision block: the sign-off with the enhanced checks as short bars | The structure roots-down, the string to the main beneficial owner, the As at / Compared with stamp ("+ New since" tags against onboarding), the trail |
| Onboarding `/onboard` | Caption "New client file". Step tabs 1 Client · 2 People and owners · 3 Consent · 4 Identity · 5 Review, Radix form controls (toggle group for client type, selects, checkboxes). Decision block: Back / Continue | The structure builds live as owners are added, with a ghost "Add an owner" node |
| Fuse or split `/fuse/:id` | Caption with the queue pager and "You decide" stamp. Tabs Match file (likelihood scale, field-by-field evidence with effect bars) · Record A · Record B · Past decisions (split). Decision block: Fuse / Keep apart, reason, `F` `K` `J` | Both records side by side stitched by the seam; drag one onto the other to fuse |
| Screening `/screening/:id` | Caption with the queue pager. Tabs Match (our record against the list entry; what a decision does) · Party · List entry · History. Decision block: reason (required), True match / Not a match / Escalate | The party with the list entry hanging off it as a foreign card on a dotted seam |
| Alerts `/alerts/:id` | Caption with the queue pager grouped by client. Tabs Alert (body, evidence with cites, suggested step) · What changed. Decision block: re-rate / ask the client / record the review, reason, mark as handled / dismiss | The before/after overlay for that client |
| Reports `/reports`, `/reports/:id` | Hatched caption with the lock and the access list; the case register with deadlines; concerns from the team; tabs Grounds · Evidence · Draft report · Access; decision block: save, export, mark as filed (alert dialog). Summary-access users see redaction | Only the case's subjects; a hatched frame round the board |
| Ask the board `/ask` | The line of enquiry: question field, try-phrases, the written answer with numbered cites, how it was found, earlier enquiries. Decision block: pin to the dossier, open the dossier, copy | The path the answer used, each cited link numbered |
| Programme `/programme` | Wide folio: partners' brief in sentences, obligations as numbered paragraphs (select one to light its clients), clients by rating as a glyph strip, patterns worth knowing, print | The constellation dimmed to the selected obligation |
| Activity log `/activity` | Full folio: a sealed register with filters, Export and Verify the chain | — |
| Settings `/settings/:section` | Full folio with tabs Firm · Members (invite in a dialog) · Risk method (publish in an alert dialog, the second-opinion differences, the check versions) · Screening lists · Retention · Notifications | — |

The **restricted** treatment is unchanged: only the compliance officer and named delegates see the Reports route, the rail icon, the docket clock and the dossier's Restricted tab; everyone else gets the same "This page isn't available to you" for restricted, missing and forbidden ids. The deadline stamp is computed at runtime (AU: 3 business days; 24 hours for terrorism financing). Exports are drafts for the firm to lodge.

## 7. Type

| Role | Face | Size / line | Weight | Use |
|---|---|---|---|---|
| Display | Besley | 50 / 52 (landing only; 40 at 1100 px, 34 at 390 px) | 500, italic 500 for one emphasised word | Landing headline |
| Title | Besley | 31 / 35 | 500 | Folio captions |
| Heading | Besley | 21–25 / 28 | 500 | Tab titles, decision headings, landing paragraphs |
| Reason | Besley | 15.5–16.5 / 24 | 400 | Reasons, answers, the partners' brief, any "why" sentence |
| UI | Ysabeau Office | 15 / 22 | 400 / 600 / 700 | Body, buttons (600), nav |
| Label | Ysabeau Office | 12.5–14 / 16 | 700 | Section heads, column heads, stamps. **Sentence case, never tracked caps.** |
| Data | Sometype Mono | 11.5–13.5 / 16 | 400–600 | ACN/ABN, %, dates, scores, seals, exhibit ids, reference lines |

**Besley** (Owen Earl) is a Clarendon revival: Clarendon was the first type designed as a related bold and became the face of notices and official printing, and the Seventh Circuit's guidance on briefs names it. **Ysabeau Office** (Christian Thalmann) is a humanist sans built on Garamond letterforms whose Office cut makes tabular lining figures the default, so registers align. **Sometype Mono** (Ryoichi Tsunekawa) was made for tabular layout and is used only for identifiers and figures. Self-hosted with `@fontsource/besley`, `@fontsource/ysabeau-office` and `@fontsource/sometype-mono`. Rule: **Besley speaks, Ysabeau works, Sometype counts.**

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
| `--string-tint` | `#F5E3E6` | `#321820` | Ghost fuse node, high-risk chip fill |
| `--on-string` | `#FFFFFF` | `#170A0D` | Text on oxblood |
| `--clear` / tint | `#2F6B4F` / `#E3EFE8` | `#6CC29A` / `#183026` | ● Clear |
| `--review` / tint | `#8A6100` / `#F6ECD3` | `#E3B24F` / `#352A12` | ◆ Review |
| `--high` / tint | `#9B1C31` / `#F5E3E6` | `#E35D71` / `#321820` | ▲ High |
| `--restricted` | `#2B2F33` on 135° hatch | `#C7CCD0` on hatch | 🔒 Restricted |
| `--edge-own` | `#3A4146` | `#AEB6B9` | Ownership edges |
| `--edge-ctrl` | `#6B7377` | `#858E92` | Control edges |
| `--edge-faint` | `#B9C0BE` | `#3A4246` | Constellation links, minimap |

Hue family: oxblood ≈ 350°. **No orange anywhere.** No gradients except the hatch. Shadows: `--shadow-paper` (three-layer soft paper shadow).

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

Chips: 2 px radius, 12.5 px Ysabeau Office 600, glyph first. Match likelihood is always "87 in 100", never "0.87" or "87% confidence".

## 10. Shape language and components

- **Radius 2 px everywhere** (paper, not pills). The only round things: person nodes, the firm stamp, count badges, citation numbers.
- Paper surfaces: 1 px `--paper-edge` hairline + `--shadow-paper`. Registers: 1 px rules, no zebra, no row cards.
- **Notched folder tabs**: 34 px tall (active 38 px), corners clipped 6 px, sitting on a band of canvas above the paper.
- **Caption**: mono reference line, serif title, stamps; restricted captions are hatched.
- **Decision block**: a double rule (1.5 px ink + 1 px rule) across the folio foot.
- **Binding**: a 9 px gutter with a stitched centre line.
- Buttons: 38 px, 2 px radius. `string` = oxblood fill (primary); `ink` = ink fill (neutral strong action); `line` = paper with `--rule-strong` border; `quiet` = text button; `link` = ink with a 1.5 px oxblood underline offset 4 px.
- Focus: 2 px canvas gap + 2 px oxblood ring on everything focusable, including graph nodes and every Radix primitive.
- Density: medium; 8 px base grid; folio padding 26/34.
- Logo: wordmark "Kinroot" in Besley italic 500 with a glyph: a small square (company) whose oxblood thread, knotted once, runs down to a circle (person).

**Component system.** shadcn/ui primitives live in `src/components/ui/` and read the same tokens through `@theme inline` (`--color-primary` is the string, `--color-popover` the paper, every radius 2 px, shadows the paper shadow):

| Need | Component |
|---|---|
| Actions | `Button` (string, ink, line, quiet, link; sm, icon) |
| Status | `Badge` with a glyph and a word (`Status`, `RatingTag`) |
| Folder tabs | `Tabs` |
| Firm switcher, account menu | `DropdownMenu` |
| Spine labels | `Tooltip` |
| Find | `CommandDialog` (cmdk) |
| Queue pager, compare date | `Popover` + `Command` |
| Confirmations (mark as filed, publish a method) | `AlertDialog` |
| Invite someone, set a rating by hand | `Dialog` |
| Toasts | `Sonner` (pinned slips) |
| Fields | `Input`, `Textarea`, `Select`, `Checkbox`, `ToggleGroup`, `Label` |
| Registers | `Table` + TanStack Table (docket, client book) |
| Folio and exhibit | `ResizablePanelGroup` |
| Phone More | `Sheet` |

## 11. Graph styling spec

**Layout:** structure views use a layered **roots-down** layout (client at the top, owners beneath; dagre/ELK layered, rank separation 160 px, node separation ≥ 205 px so labels never collide). The constellation uses ForceAtlas2 (web worker, ≤ 1.5 s, then frozen and cached). Labels sit **to the right** of the shape (max width 146 px, two lines), so incoming arrows from below never cross them.

**Nodes** (BOVS-derived):

| Party | Shape (38 px; client 46 px) | Inside | Notes |
|---|---|---|---|
| Person | circle, 1.5 px ink outline, paper fill | initials, Ysabeau Office 700 12 | PEP: small "PEP" badge top-right |
| Company | square, radius 2 | ISO country code, Sometype Mono 600 11 (AU, GB, VG) | listed company: a 2 px bar under the square |
| Trust / arrangement | square with an 11 px folded top-right corner | "T" | trustee and appointor drawn as control edges |
| Partnership | square split by a vertical rule | "P" | |
| Unknown party | dashed outline | "?" in Besley | label "Unknown shareholders · 1 or more" |
| Stack (many similar) | dotted outline with an offset copy behind | count | "41 companies · Dormant"; opens into its members |
| Client | 46 px, 2.5 px border, **oxblood pin dot** above | as type | |
| Beneficial owner | shape filled oxblood, 4 px canvas gap + 1.5 px oxblood ring | white initials | name in oxblood; sub "Beneficial owner · 49.6%" |
| Selected | 4 px canvas gap + 1.5 px ink ring | | |
| Dimmed (not a neighbour of hover/focus) | 35% opacity | | |

**Edges** (arrow from the interested party to the subject; arrowheads always drawn):

| Relationship | Style | Label |
|---|---|---|
| Owns | solid 1.6 px `--edge-own`, arrowhead 4.2× thickness | "62%" in Sometype Mono 11, on a canvas-coloured pill at the midpoint |
| Controls (director, appointor, trustee, nominee, signatory) | dashed 6/4, 1.5 px `--edge-ctrl` | role in Ysabeau Office italic 11.5 ("Director") |
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

Libraries: Motion for folio tabs and layout; Sigma camera `animate` + a small rAF tween for node positions; CSS for small UI. Everything animates transform/opacity (or SVG path data), 60 fps.

| Name | What moves | Duration / easing | Reduced motion |
|---|---|---|---|
| **Unfold** | a layer of owners springs out of its parent: position from parent → slot, scale .6 → 1, opacity 0 → 1 in the first 45% | 620 ms per hop, 90 ms gap between hops; spring stiffness 220, damping 22 (≈ 6% overshoot); edges follow their nodes | structure appears settled at once |
| **Pull the thread** | the string appears **slack** (each segment sags 46 px, alternating sides) and snaps **taut** (damped: `1 − e^(−6t)·cos 9t`); a 6 px knot travels from owner to client; the % tag steps per hop; the owner fills oxblood at the end (180 ms) | 900–1100 ms; knot linear in arc length | string drawn taut, no knot, final equation shown |
| **Fuse** | drag a node: it follows the pointer 1:1; within 64 px of a candidate it is pulled in (spring 400/30) and the seam's cross-stitches appear left to right (12 ms stagger); on confirm both nodes slide to the midpoint, edges re-attach (endpoint tween 300 ms) and the knot pulses once (scale 1 → 1.15 → 1, 240 ms) | 420 ms spring | nodes swap to the fused node instantly; a 120 ms fade |
| **Split** | stitches unpick right to left, the nodes spring apart to their own slots | 480 ms | instant |
| **Redact** | black bars sweep left to right across each restricted field, then the lock fades in | 220 ms per field, 40 ms stagger, `cubic-bezier(.65,0,.35,1)`; lock 120 ms | bars appear at once |
| **Folio settle** | a new record settles into the folio from 6 px with a fade; the exhibit stays put and its camera flies | 220 ms `cubic-bezier(.2,.8,.2,1)` | instant |
| **Folder tab** | active tab rises 4 px; paper content cross-fades (no slide) | 160 ms / 140 ms ease-out | instant |
| **Pin a slip** | toasts (and the landing slip) drop from 10 px above with a 0.6° tilt that settles flat; the oxblood pin dot sits at the left | 600 ms `cubic-bezier(.2,.8,.2,1)` | instant |
| **Docket rows** | the first paint staggers rows 18 ms apart (opacity + 4 px), once | 320 ms | instant |
| **Dialogs and menus** | fade + 2 % zoom from tw-animate-css; no slides from the edge except the phone sheet | 120–200 ms | instant |
| **Before/after** | added edges pop their "+" tag (scale .8 → 1, 180 ms); removed edges fade to 35% and turn dashed (300 ms). No scrubbing, no line-drawing reveal. | | static |
| **Seal check** | Verify the chain: each row's chain-link glyph closes (two halves meet, 160 ms) with a 25 ms stagger, then the summary line appears | | summary only |
| **Fly to** | camera to a pin from the constellation | 450 ms quadInOut | jump |

What Kinroot **never** uses: self-drawing outlines with `stroke-dashoffset`, time-ruler scrubs, plain 150 ms page fades as the only motion, 3D flips, parallax or scroll-jacking.

`prefers-reduced-motion: reduce` switches every row to its right-hand column; the landing renders its settled state.

## 13. Copy voice

Precise, legal, calm. Short declaratives. Sentence case. No exclamation marks, no "Oops", no emoji in UI. Name the person and the number ("Margaret Calder owns 49.6% through two companies"), then the next step ("Next: ask for Halyard's register of members").

- **Verbs and CTAs:** Trace a client · Open Harbourline's files · Pull the thread · Fuse into one person · Keep apart · Split into two · Sign off · Request from client · Re-rate · Dismiss (with a reason) · Pin to dossier · Export for AUSTRAC · Mark as filed · Verify the chain · Invite someone.
- **The machine-learning parts are described by what they do:** "match likelihood 87 in 100", "second opinion", "pattern check". The rules-based rating is "the risk method".
- **Compliance claims:** "designed to support", "aligned with", "built for the AML/CTF Act 2006 and the UK Money Laundering Regulations 2017". Never "certified", "compliant", "guarantees" or "approved by AUSTRAC/the FCA".
- **Tipping-off:** restricted copy says what to do, not what is inside ("Restricted. Do not discuss this with the client or anyone outside this list."). Error and empty states never reveal whether a restricted record exists.
- **Never in rendered UI:** RAG, retrieval, embeddings, vector, rerank, LLM, model or provider names, LiteLLM, prompt, tokens, SQL, architecture, pipeline, agent internals, A2A/MCP, latency, fallback, cache. Also avoid for this product: "AI-powered", "smart", "magic", "algorithm", "Cypher", "graph database", "node"/"edge" in user-facing copy (say person, company, trust, link, connection; the citation ids `E-07` stay).
- **Dates and the as-of convention:** the repo's copy is written as of **mid-October 2025**. Australia's Tranche 2 obligations **"commence 1 July 2026"**; never "are now live", "took effect" or "since July" in hard-coded text. Anything time-sensitive is computed at runtime from today's date: before 1 July 2026, "Tranche 2 obligations start in N days"; from that date, "Tranche 2 obligations in force since 1 July 2026". SMR deadlines, review-due tags, "new this week" and seeded demo dates are relative to today at runtime. Keep all other copy timeless.

## 14. Design choices at a glance

| Dimension | Kinroot |
|---|---|
| Metaphor | **Investigation board + case files: a brief filed with its exhibit** |
| App shell | **Ink-black 64 px icon spine + resizable folio (the record: caption, folder tabs, body, decision block) bound to the exhibit (the board)** |
| Component system | **shadcn/ui on Radix, re-skinned to paper: 2 px corners, hairlines, oxblood focus** |
| Landing | **The board itself: type into the client pin, roots grow, red string pulled; the sections below read as numbered paragraphs** |
| Home | **The docket (decisions by due date) beside the client constellation with lenses** |
| Data idiom | **Captions, registers, numbered paragraphs, reason lists with cited links, and the graph** |
| Type | **Besley (speaks) + Ysabeau Office (works) + Sometype Mono (counts only); sentence-case labels** |
| Palette | **Cool bond-grey #E8EBEA dot grid + white paper + oxblood #9B1C31 string; no orange** |
| Motion | **Unfold springs, slack-to-taut string with travelling knot, stitch fuse/unpick, redaction sweep, folio settle, pinned slips** |
| Signature interactions | **Pull the thread (with its trail) · Fuse or split · Before/after overlay · Find (`/`)** |
| CTAs | **Trace a client / Open Harbourline's files** |

## 15. Prototype

A static prototype (`kinroot.css`, `board.js`, `index.html`, `dossier.html`, `fuse.html`; no build step) validated the board engine, the landing trace, the dossier and the match review before the app was built. It is not included in this repository; `src/graph/engine.ts` grew out of its `board.js`.

## 16. Build notes

- **Versions.** The app pins `sigma@3.0.3` (the patch release of the 3.0 line validated in the prototype) and `graphology@0.26.0`; Motion 12 and lucide-react are used for UI motion and icons. Fonts are bundled offline with `@fontsource` (Besley, Ysabeau Office, Sometype Mono). shadcn/ui components were added with the shadcn CLI (`components.json`, new-york style) and then re-skinned; the Radix primitives come from the single `radix-ui` package.
- **One engine for every board.** `src/graph/engine.ts` is the prototype's `board.js` grown into a class: Sigma owns the camera, a custom bbox fitted to the visible part of the board (floating chrome is an inset, so the structure never sits under the exhibit label or the trail), hit-testing and the WebGL ownership arrows; the HTML/SVG evidence layer draws shapes, labels, dashed control links, tags, citation badges, the fuse seam and the red string. Links that skip a row, and parallel owns/controls pairs, bow so they never cut through a label.
- **Constellation.** With ~30 clients per firm the constellation also uses the evidence layer (focusable pins with rating glyphs and review tags) instead of pure WebGL; ForceAtlas2 runs synchronously from a seeded start, then labels are de-collided. Switch to WebGL pins with `@sigma/node-border` if a book grows past a few hundred clients.
- **Folio portal.** Routes render their record with `<Folio>` (`src/shell/Folio.tsx`), a portal into the folio panel; the route itself renders inside the exhibit, so its board chrome sits on the board. A route asks for a folio width, and the shell resizes the panels.
- **Ledger twin.** Wherever WebGL is unavailable (and always for screen readers) the board renders a text version of the same scene; the dossier's Owners tab is the full ledger twin.
- **Data.** `src/api/endpoints.ts` is the typed client for `docs/API_CONTRACT.md`. `VITE_API_MOCK=1` swaps `fetch` for an in-browser fixture adapter (`src/api/mock`) that follows the same contract, including tipping-off 404s; tests use the same adapter. The real API (Vite proxy `/api` → :8020) is the default.
