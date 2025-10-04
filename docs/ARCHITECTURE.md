# Kinroot architecture

Kinroot is a modular Django monolith with an embedded property graph beside the relational system of record,
a DB-backed job worker, classical ML for entity resolution and a risk challenger, and a React web app.
Everything runs on one laptop with no servers beyond the API and the worker.

```mermaid
flowchart LR
  subgraph Browser["Web app :3020 (React, Vite, TanStack Query, Sigma.js)"]
    UI[Board canvas · dossiers · queues]
  end

  subgraph API["API :8020 (Django 5 + DRF, ASGI/uvicorn)"]
    MW[Request id · security headers · sessions + CSRF · throttles]
    V[api/ views + serializers]
    SSE[/events/stream SSE/]
    subgraph Platform["Platform"]
      ACC[accounts · RBAC]
      CLI[clients: system of record]
      CAS[cases · SMR · tipping-off]
      AUD[audit hash chain]
      JOB[jobs queue + event outbox]
    end
    subgraph Domain["Domain core"]
      GR[graph api: UBO · paths · diff · clusters · features]
      ER[resolution: blocking → features → FS + LightGBM → SHAP]
      SCR[screening: lists + matcher]
      RSK[risk: rules of record + challenger]
      MON[monitoring: re-screen · alerts · reviews · drift]
      AST[assistant: graph tools + offline fake / LiteLLM]
    end
  end

  W[Worker: manage.py runworker<br/>single graph writer]
  DB[(SQLite / Postgres<br/>system of record)]
  G[(LadybugDB graph file<br/>read-only in API)]
  ML[(mlruns/ MLflow<br/>artifacts/models)]
  DATA[(data/: OpenSanctions,<br/>Companies House sample)]
  LLM{{Cloud LLM, optional<br/>LLM_FAKE=true default}}

  UI -- "/api (same origin, cookies)" --> MW --> V
  UI <-- SSE --> SSE
  V --> Platform
  V --> Domain
  Platform --> DB
  CLI -- "signals → GraphOutbox" --> DB
  JOB --> DB
  SSE -- tails Event rows --> DB
  W -- claims jobs --> DB
  W -- "graph.sync (RW)" --> G
  GR -- "portable Cypher (RO)" --> G
  ER --> ML
  RSK --> ML
  SCR --> DATA
  AST --> GR
  AST -.-> LLM
```

## Request path
1. The browser talks only to `:3020`; Vite proxies `/api` to `:8020`, so session and CSRF cookies are first-party.
2. `RequestContextMiddleware` assigns `X-Request-ID`, binds it to structured logs and records Prometheus metrics;
   `SecurityHeadersMiddleware` sets CSP, `nosniff`, frame and referrer policies and `no-store` on API JSON.
3. DRF authenticates the session (`SessionAuthentication`, CSRF enforced), resolves the active organisation from
   the membership, checks the endpoint permission (`accounts/roles.py`) and applies throttles.
4. Views call the domain core only through `<app>/api.py` and serialise dataclasses from `kinroot/contracts.py`.
5. Errors leave as RFC 7807 problem details with a stable `code`.

## Data and consistency
- **System of record**: Django models (Part 2 of the contract). Relationships carry validity dates and are ended
  rather than deleted, which gives point-in-time answers.
- **Graph projection** (ADR 0001, 0002): signals write a transactional outbox; the worker is the single
  read-write owner of the LadybugDB file and applies the outbox in order; the API reads through a read-only
  handle reopened when `graph_version` changes. `rebuild_org` recreates the projection from Django.
- **Jobs**: `jobs.Job` rows claimed with compare-and-set (SQLite) or `FOR UPDATE SKIP LOCKED` (Postgres), leased,
  retried with backoff. **Events**: `jobs.Event` rows; the SSE endpoint tails them by id, so the worker process can
  notify browsers without Redis.
- **Audit**: per-organisation SHA-256 hash chain; restricted (case) rows stay in the chain but are listed only to
  case-cleared users.

## Domain core
- **UBO engine**: hop-by-hop upstream fetch (portable Cypher), simple-path enumeration in Python, effective
  ownership = Σ over simple paths of Π pct; control roles make a UBO regardless of %; cycles detected and
  reported; plain-language path sentences.
- **Entity resolution** (ADR 0003): blocking → similarity features → Fellegi-Sunter baseline and calibrated
  LightGBM champion → thresholds from the PR curve → SHAP reasons → merge/split queue with human decisions.
- **Screening**: sanctions/PEP lists (bundled fictional sample by default, OpenSanctions subset optional) matched
  with the same name/date features; hits reviewed with reasons; re-screen on list updates.
- **Risk** (ADR 0004): versioned rules methodology is the decision of record; LightGBM challenger (logistic
  baseline) with SHAP; disagreements to review; EDD triggers and two-stage sign-off.
- **Monitoring**: list-update re-screens, structure-change alerts from graph sync, review scheduling by rating,
  PSI drift on model inputs.
- **Assistant**: deterministic planner over six graph tools when `LLM_FAKE=true`; LiteLLM model chain otherwise.
  Every sentence cites graph edges/nodes; ungrounded drafts are withheld. No access to case data (ADR 0005).

## Security and compliance controls
Argon2id passwords; 30-minute idle / 12-hour absolute sessions with rotation on refresh; CSRF on all unsafe
methods; per-user and per-IP throttles; strict security headers; tenant isolation on every query and every graph
node; least-privilege roles; tipping-off controls (ADR 0005); 7-year (AU) / 5-year (UK) retention with legal
hold and dry-run disposal; uploads size- and type-checked and stored outside any served path; secrets only from
environment variables. Designed to support the AML/CTF Act 2006 (Cth) and Rules (Tranche 2 obligations commence
1 July 2026), the Privacy Act 1988 (APPs), the UK MLR 2017 and UK GDPR; no certification is claimed.

## Observability
`/health` (liveness), `/health/ready` (database, graph backend, assistant mode), `/metrics` (Prometheus: HTTP,
throttles, audit appends, jobs, graph query latency and sync lag, ER decisions, screening hits, disagreements,
assistant answers). Structured logs carry the request id.

## Runtime footprint
API (uvicorn) + worker + Vite dev server; SQLite and the graph file in `data/`; Python venv about 620 MB;
LightGBM needs the OpenMP runtime on macOS (`brew install libomp`). Training runs one job at a time on CPU.

## Platform details
- **Sessions**: server-side sessions in the database. Sign-in records a 12-hour absolute and a 30-minute idle
  deadline in the session; `/auth/refresh` rotates the session key and moves the idle deadline. Past either the
  API answers `401 session_expired` (distinct from `not_authenticated`). Changing a password invalidates every
  other session through Django's session auth hash. Five failed sign-ins for one email in 15 minutes lock it for
  15 minutes; failures are generic and audited.
- **Tenancy**: the active organisation comes from the session and the user's membership, never from the URL or
  body. Every lookup filters by it; ids from another firm raise the same 404 body as unknown ids (tested per
  resource). Domain calls receive only the active org id.
- **Permissions**: views declare one permission (or an any-of tuple) from `accounts/roles.py`; the base view
  resolves membership and permissions once per request. Error bodies never echo restricted content.
- **Tipping-off**: `cases.services.access_level` is the single gate: the compliance officer has full access,
  others need an access-list entry, everyone else gets 404. Case actions are restricted audit rows (still in the
  hash chain), case events carry named recipients, dashboard counts omit case numbers without `smr:read`, the
  assistant receives the caller's permissions minus every `smr:*`, and every hold, whatever its cause, answers
  `409 action_held` with one sentence.
- **Jobs and events**: `jobs.Job` rows are claimed by compare-and-set (`SKIP LOCKED` on Postgres), leased for
  `JOBS_LEASE_SECONDS`, retried with exponential backoff and recovered when a lease expires. The same worker loop
  drains the graph outbox when it is the single writer and enqueues `monitoring.daily` once per org per day.
  `jobs.Event` rows feed the SSE stream, which filters per recipient by permission and named users and resumes
  from `Last-Event-ID`; the stream closes every five minutes and the browser reconnects.
- **Audit**: one SHA-256 chain per organisation over a canonical JSON of each row (UTC timestamps, sorted keys);
  `verify_chain` reports the first broken row. Sample-data history is written in time order so the seeded chain
  verifies like any other.
- **Uploads**: identity documents are size-limited, sniffed by content (PDF, PNG, JPEG), stored under random
  names outside any served path, hashed (SHA-256) and returned only as attachments.
- **Retention**: preview lists exited clients and their documents with the date each becomes disposable (7 years
  AU, at least 5 UK) and any legal hold; a confirmed run anonymises personal fields of people no other client
  references and deletes stored files, leaving the audit chain intact.

## Domain core in detail (graph, resolution, screening, risk, monitoring, assistant)

### Graph projection and queries
- Schema (LadybugDB DDL; Neo4j constraints in the adapter): node tables `Party` (`orgId`, `kind`, `name`,
  `normName`, `jurisdiction`, `identifiers`, `isNominee`, `dormant`…) and `Address`; relationship tables `OWNS`,
  `CONTROLS` and `REGISTERED_AT`. Every edge stores `fromId`/`toId`, so results never depend on engine-internal
  ids. Addresses are deduplicated per firm by a normalised-address key, which is what makes shared-address
  clusters visible.
- Writes: `graph/sync.py` drains `GraphOutbox` in sequence, collapsing repeats so the current database state is
  projected. Party ops run before relationship ops; an edge upsert deletes by id first (a merge may have moved its
  endpoints). Batches use `UNWIND`; batches without percentages omit `pct` (an all-null column would be typed as
  text by the binder).
- Reads: `graph/repo.py` holds every Cypher statement. Traversal is hop by hop (`WHERE n.id IN $ids`, bounded by
  `GRAPH_MAX_DEPTH`), and paths are assembled in Python (`graph/ownership.py`), so the answer is identical on
  LadybugDB (walk semantics) and Neo4j (trail semantics).
- UBO (`compute_ubo`): a depth-first walk over simple upstream paths. A person's effective share is the sum of the
  products along each path. Over-allocated registers are scaled to 100%, and `nominee_for` edges pass a
  nominee's holding through to the principal. Ownership that leaks into a cycle, an undisclosed holder, a missing
  allocation or the depth limit is accounted for as `unexplained_pct`, so traced plus unexplained always sum to
  100%. Control UBOs: trustee, appointor, protector, significant control and nominee principals on the client or
  on any upstream entity holding at least the threshold (or any trust in the chain); directors of a corporate
  trustee count. When nobody qualifies, the senior managing official (or a director) is recorded.
- Decoration happens at read time from the system of record (client ids, cached ratings, screening flags, merge
  counts), so a rating change never needs a graph write.

### Entity resolution
`resolution/normalize.py` → `blocking.py` (nine key families, blocking recall 0.98 on the test fold) → `features.py` (15 stable
features) → `fellegi_sunter.py` (EM, unsupervised) and the LightGBM champion with isotonic calibration
(`model.py` loads the committed artifacts). The merge policy adds a conflicting-evidence guard: different full
dates of birth, different registration numbers or clearly different addresses never auto-merge. Reasons come from
LightGBM's exact TreeSHAP (`pred_contrib`) mapped to plain language (`reasons.py`). Training is in
`resolution/ml/` (`python manage.py train er`).

### Screening
`screening/matcher.py` is a pure scorer. A phonetic token index narrows candidates, then a token-aligned name
similarity (Jaro-Winkler blended with an edit ratio, order-free, initials-aware, generic company words ignored)
is adjusted by birth-date and country corroboration. Every adjustment is a reason. The list data is
versioned reference data (`ListVersion` / `ListEntry`). A new version enqueues an org-wide re-screen, and new
hits found then raise `list_update_hit` alerts.

### Risk
`risk/rules.py` holds the methodology as data with a small condition DSL, bands and mandatory floors.
`risk/features.py` builds one flat feature dict from the graph features, screening and onboarding answers.
`risk/challenger.py` scores the same dict and decides agreement under the policy in `policy.json`. An assessment
is idempotent for identical inputs (`inputs_hash`). Every reason cites graph evidence (edge, node or hit ids).
Training is in `risk/ml/` (`python manage.py train risk`). PSI drift compares the current book with
`drift_reference.json` once at least 50 clients are assessed.

### Monitoring and the assistant
Structure-change alerts fire only for relationships that start or end inside the monitoring window and after
onboarding, so re-pointing records during a merge never alerts. The assistant's tools are permission-checked,
read only graph, screening and risk records (never cases), and every answer passes a grounding check (every
sentence must carry valid citation markers); cloud drafts that fail it are replaced by the deterministic answer.
