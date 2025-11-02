# Kinroot frontend design v4: calm, in layers

> v4 replaces "the structure chart" (v3), "brief and exhibit" (v2) and "the investigation board" (v1). Same product, data, routes, roles and demo clock; a calm face built on progressive disclosure.

Kinroot is customer due diligence and beneficial-ownership software for Australian law firms, accountants and conveyancers under the AML/CTF Act (Tranche 2), and for UK firms under the Money Laundering Regulations 2017. The demo firm is **Harbourline Legal (Sydney)**; the demo clock is October 2025.

Stack (unchanged): React + Vite + React Router + TanStack Query + Tailwind 4.1, **shadcn/ui** on Radix (`src/components/ui/`), TanStack Table, cmdk, Sonner, Motion, lucide-react, Sigma.js 3 + graphology as the chart's camera, with Kinroot's own plate and line layer on top.

## 1. Analysis: why v3 failed

The owner called v3 "pathetic". Looking at its screens as a first-time viewer:

| Problem in v3 | Evidence | v4 rule |
|---|---|---|
| Shouting type | Syne 800 wide capitals for every title, a 168 px numeral on the Desk | One title per screen, sentence case, medium weight, 22–24 px |
| Everything at once | Reference line + title + facts + stamps + chart bar + legend + trace line + sign-off bar on one dossier screen | Each screen shows one thing first; detail is one click or one scroll away |
| Facts said twice | "7 waiting" in the poster, the ticket count line and the tallies | Each fact appears once per screen |
| Puzzle chrome | Trail bar of shape glyphs, full-screen "Index", depth gauge, "Exhibit A", layer labels | Plain top navigation with five words; a chart toolbar with three icons |
| Noisy chart | Layer rules, register numbers inside plates, role words on every line, a long equation tag | Names and percentages only; everything else opens on click |

The target calm is Vortex v2 (neutral, one title, labels of one to three words) without copying its identity: Vortex has a left sidebar, Inter and zinc; Kinroot has a top bar, Albert Sans and plum.

## 2. Information architecture

Top bar (56 px), the same on every app screen:

```
[mark Kinroot]   Home · Clients · Reviews (6) · Reports · Programme        [Search ⌘K]  [Ask]  (DC ▾)
```

- **Home** `/board`: what waits on you, and the client book.
- **Clients** `/clients` → dossier `/clients/:id/:tab`; **New client** `/onboard` from the Clients header.
- **Reviews**: one place with three tabs, each its own route: Screening `/screening`, Duplicates `/fuse` (merge or keep apart; split later), Alerts `/alerts`; each item opens its detail route (`/screening/:id`, `/fuse/:id`, `/alerts/:id`). Decided items live in a "Decided" list on each queue page, never inside another item.
- **Reports** `/reports`, `/reports/:id`: only for people who may see restricted cases; nobody else sees the word.
- **Programme** `/programme`.
- **Ask** `/ask`: a button on the right of the bar.
- The **account menu** holds the firm switcher, Activity log `/activity`, Settings `/settings/:section`, light/dark and sign out.
- **Search** (`/` or ⌘K) finds a person, company, trust or page.
- Phones: the bar keeps the mark, Search and a Menu button; Menu opens a sheet with the same five words and the account items.

Routes, roles and permissions are unchanged; `/waiting` and `/more` remain as phone-friendly pages.

## 3. Layers per screen

| Screen | First layer (3 seconds) | Second layer | Detail |
|---|---|---|---|
| Landing | "Who really owns your client?", a live sample chart tracing to the owner, one button | Three sample switches; three one-line benefits | Sign in; the demo firm |
| Sign in | One card: email, password, Sign in | "Use a sample account" opens four roles | — |
| Home | "Waiting for you" list (title, due) beside the client book | Lens switch on the book; hover a row to light its client | Click a row → its screen; click a client → its dossier |
| Clients | Title, search, a table of name · rating · next review | Filter tabs | Row → dossier |
| Dossier | Name + rating, the ownership chart traced to the main owner, the owner's share | Tabs under the chart: Summary · Owners · Screening · Risk · Documents · Timeline (+ Restricted) | Click a party → drawer with its role, share, path and checks; Sign off opens a dialog |
| Reviews | Tabbed list of items | — | Item → detail |
| Screening match | "X against list entry", likelihood, our record vs the entry | Chart of the party and the entry | Decide in a dialog with a reason |
| Duplicate | Two records side by side with = / ≈ / ≠ per field, likelihood and policy bands, why it was held | Chart with both records joined (long lists of directorships fold into one "N companies" plate) | Merge (confirm), keep apart (reason), split later (confirm) |
| Alert | What happened, the client's chart with changes marked | Evidence (links, matches); for a rating change, the reasons behind the new rating | Re-rate or ask the client (confirm), handle or dismiss (note) |
| Reports | Restricted list with deadlines | Case tabs | Draft, export, mark as filed |
| Ask | "Ask about a person, company or trust" + three suggestions | Answer with numbered links, the chart of the path | Pin to dossier, copy, how it was found, history |
| Programme | One brief sentence block, the obligations as rows with a status | Expand a row to see its clients | Print |
| Activity log | Table: when, who, what | Filters, verify, export | — |
| Settings | Section list beside the section | — | Dialogs for invites and rating changes |

## 4. The ownership chart (the hero, quiet)

- Owners above, the client at the foot; elbow lines; arrowheads into the subject.
- **Plates**: company = rounded rectangle; trust = pill; person = circle with initials, name beneath; unknown = dashed. The client plate has a plum outline. Only the name is drawn; register numbers, roles and flags live in the party drawer. A flagged party gets one small coloured mark.
- **Lines**: owns = solid with a small % chip; controls = dashed, unlabelled (the key says what dashed means); unknown = dotted.
- **The trace**: one plum line from the client up to the beneficial owner, the owner's circle filled plum, one chip with the effective share ("49.6%"). The working (100% × 80% × 62%) is in the drawer.
- **Toolbar** (top right, icon buttons with tooltips): Changes (compare with onboarding, off by default on dossiers), Key (popover legend), zoom out, zoom in, fit.
- No layer labels, no minimap, no "Exhibit" titles. Chart ground is a flat sunken tone, no dot grid.

## 5. Tokens

Calm warm-neutral greys with one restrained accent: **plum ≈ 305°**, used for the primary button, the active nav word, links, focus and the trace. Status colours never carry meaning alone (dot + word).

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#FAF9F8` | `#121111` | page |
| `--surface` | `#FFFFFF` | `#1A1918` | cards, bar, inputs |
| `--subtle` | `#F3F1EF` | `#232120` | hover, table head |
| `--sunken` | `#F5F4F2` | `#161514` | chart ground |
| `--border` | `#E6E3DF` | `#2C2A28` | hairlines |
| `--border-strong` | `#D3CFCA` | `#3D3A37` | control borders |
| `--fg` | `#1D1B1A` | `#EEECEA` | text |
| `--fg-2` | `#4A4542` | `#C2BDB8` | secondary text |
| `--muted` | `#6F6863` | `#9A938D` | captions (≥ 4.5:1) |
| `--accent` | `#74406F` | `#D3A6CD` | plum |
| `--accent-hover` | `#62355E` | `#E0BADB` | |
| `--accent-fg` | `#FFFFFF` | `#22141F` | text on plum |
| `--accent-tint` | `#F4EDF3` | `#2D2030` | selection, active nav |
| `--high` / tint | `#B42318` / `#FDF0EE` | `#F2877B` / `#3A1D1A` | high risk, matches |
| `--review` / tint | `#9A5B0A` / `#FBF3E4` | `#E5A84B` / `#35270F` | review |
| `--clear` / tint | `#18794E` / `#EAF5EF` | `#5CC08F` / `#14291F` | clear |

Radius 8 px for controls, 12 px for cards and dialogs, full for chips. Borders over shadows; one soft shadow (`0 1px 2px rgb(0 0 0 / .04), 0 4px 16px rgb(0 0 0 / .04)`) on floating layers only. Density: 40 px controls (32 small), 48 px table rows.

## 6. Type

| Role | Face | Use |
|---|---|---|
| Headings | **Albert Sans** (variable) 500 | One title per screen, 24 px (20 on phones), sentence case, normal tracking; section labels 15 px 600 |
| UI / body | **Albert Sans** 400–600 | Body 14 px/1.55, labels 13 px 500 |
| Numbers / IDs | **Roboto Mono** 400–500 | ACN/ABN, case references, seals; percentages use Albert Sans tabular figures |

Heading style category: **grotesk-humanist sans (Albert Sans), sentence case, medium weight, no tracking tricks**. Syne, Onest and Martian Mono are retired.

## 7. Status language

| Status | Mark | Word |
|---|---|---|
| Clear | green dot | "Clear" / "ID verified" |
| Review | amber dot | "Review" / "Ask client" |
| High | red dot | "High" / "Possible match" |
| Restricted | lock | "Restricted" |
| Unknown | hollow dot | "Not yet known" |

Match likelihood is written "87 in 100".

## 8. Motion

Quiet and short (Motion + the engine's tweens; transform and opacity only; `prefers-reduced-motion` makes all of it instant): pages fade in 160 ms; chart plates fade up layer by layer (300 ms each); the trace draws upward once (900 ms); drawers slide 200 ms; fuse slides two plates together.

## 9. Copy

Labels of one to three words, no explanatory paragraphs, detail in tooltips and drawers. CTAs: Open the sample firm · Sign in · Sign off · Merge · Keep apart · Split · Re-rate · Ask the client · Mark as handled · Pin to dossier · Export · Mark as filed · Verify · Invite. Internal link codes (E-04) and system names ("System", method codes) are never shown; Kinroot's own actions are attributed to "Kinroot". Compliance claims say "designed to support"; never "certified" or "compliant". Never in rendered text: RAG, retrieval, embeddings, vector, rerank, LLM, model or provider names, prompt, tokens, SQL, architecture, pipeline, latency, fallback, cache, "AI-powered", "smart", "algorithm", "node", "edge". Tranche 2 timing is computed at runtime.

## 10. Decisions and their confirmations

Every action that changes a record or reaches the client asks first: merge, split, re-rate, ask the client, open a case and mark as filed open a confirmation; keep apart, screening decisions, dismiss, mark as handled and sign-off open a dialog that asks for a reason or a note. A comparison never shows "=" when a side is missing ("Can't compare") or the words differ ("≈"). Identity is "verified" when an electronic or document check passed, not only when a document was uploaded.

## 11. Independent review

Two rounds by an independent reviewer acting as a first-time customer (15 Nov 2026). Round one: not ready (a crash on a merged pair, one-click actions, contradictory identity status, internal link codes, repeated facts, phone overflow). Round two: the P0s and most P1s fixed; the remaining items (adverse-media wording, the rating-alert reasons, programme repetition, grouped directorships, phone chart fit, a shorter chart so the tabs show) were fixed after it. Open P2s: overlapping % labels where one owner holds two links, backend copy that spells out FATF and PEP, and the Ask answer naming indirect ownership.

## 12. References

| Reference | What v4 takes |
|---|---|
| Vortex AI v2 screens (`~/Work/_playbook/design/vortex-ai/shots-v2/`) | The calm bar: one title, short labels, status as dot + word |
| Necessa landing | Only what matters on the first screen |
| Linear, Vercel dashboard | Top-level navigation as a few plain words; quiet tables |
| Stripe Dashboard (customers, disputes) | List → detail with a right drawer for the record |
| Open Ownership BOVS: https://www.openownership.org/en/publications/beneficial-ownership-visualisation-system/ | Owners above, arrowheads into the subject, control lighter than ownership |
| Lexchart structure charts: https://lexchart.com/the-ultimate-guide-to-company-structure-charts/ | Box, oval, circle by entity kind; percentages on the line |
| shadcn/ui: https://ui.shadcn.com | The component system, re-themed |

## 13. Build notes

- Shell: `src/shell/AppShell.tsx` (top bar, account menu, phone menu), `src/shell/page.tsx` (`Page`, `PageHeader`, `SectionTabs`, `DecisionBar`, `QueuePager`, `Section`), `src/shell/chart.tsx` (`ChartBand`, toolbar, key, trace chip, status), `src/shell/board.tsx` (one chart per page).
- Styles: `src/styles/index.css` (tokens, base, components, chart), `src/routes/pages.css` (screens), `src/routes/landing/landing.css`, `src/routes/auth/auth.css`.
- Every screen keeps its route, data, roles and keyboard paths (`[` `]` between tabs, `F` merge, `K` keep apart, `J` next on duplicates, `T` to trace).
- Tests: Vitest (`npm test`, 122) and Playwright (`npm run e2e`, 8 checks, against the running API with the demo clock; `PW_CHROMIUM` may point at an installed Chromium; browsers launch with `--mute-audio`).
