# Kinroot API contract (v1)

The binding reference for Kinroot's module boundaries. The web app builds against Part 1; the backend implements
it. Part 2 is the data model, Part 3 the Python interfaces between the platform/API layer and the domain core,
Part 4 the module map, Part 5 the demo seed, Part 6 project conventions.

Changing a shape here means changing it in the same commit as the code.

---

# Part 1: HTTP API

## 1.1 Conventions

- Base path **`/api/v1`**. The web app (Vite on :3020) proxies `/api` to the API on :8020, so the browser sees
  one origin and cookies just work.
- JSON is **camelCase** on the wire (the renderer converts from snake_case). Two kinds of map keep their keys
  as written: `features` (stable snake_case feature ids) and `attributes` (graphology attributes).
- Ids are UUID strings. Timestamps are ISO-8601 with offset (`2025-10-01T09:30:00+10:00`). Calendar dates are
  `YYYY-MM-DD`. Percentages are numbers 0–100 with up to 2 decimals. Countries are ISO-3166 alpha-2.
- `asOf` query parameters are dates; the state shown is the state valid at the **end** of that day. Omitted
  means today.
- Every response carries `X-Request-ID` (echoed when the client sends a valid one). API responses are
  `Cache-Control: no-store`. The SSE stream sends `Cache-Control: no-cache, no-transform` and `X-Accel-Buffering: no`.

### Errors: RFC 7807
Every error is `application/problem+json`:
```json
{ "type": "https://kinroot.dev/problems/validation_error", "title": "Validation failed", "status": 422,
  "detail": "One or more fields are invalid.", "code": "validation_error",
  "errors": [{ "field": "address.postcode", "message": "Enter a 4-digit postcode." }], "requestId": "…" }
```

| Status | `code` | When |
|---|---|---|
| 400 | `bad_request` | malformed JSON / query |
| 401 | `not_authenticated` | no session; `session_expired` when the idle or absolute limit passed |
| 403 | `forbidden` | permission missing (message never reveals restricted content) |
| 403 | `csrf_failed` | unsafe method without a valid `X-CSRFToken` |
| 404 | `not_found` | unknown id, **other org's id**, or a restricted case the caller may not see |
| 409 | `already_decided`, `conflict`, `stale_version`, `action_held` | state conflicts (see each endpoint) |
| 410 | `expired` | invitation link past its expiry |
| 413 | `payload_too_large` | upload over `MAX_UPLOAD_MB` |
| 415 | `unsupported_media_type` | upload type not allowed |
| 422 | `validation_error`, `weak_password`, `invalid_transition`, `over_allocated` | field errors |
| 423 | `client_blocked` | work on a client blocked by a confirmed sanctions match |
| 429 | `rate_limited` | with `Retry-After` seconds |
| 500 | `internal_error` | logged with the request id |
| 503 | `unavailable` | dependency down (with `Retry-After`) |

### Pagination
List endpoints marked *(paged)* accept `?page=1&pageSize=25` (max 200) and return
`{ "items": [...], "page": 1, "pageSize": 25, "total": 83, "totalPages": 4 }`. Filters are query parameters.
Default order is stated per endpoint. List filters named `status` also accept `all` (no status filter).

### Rate limits
Per signed-in user (else per IP), sliding per minute: `api` 300, `auth` 10 (login, signup, refresh, password,
invitation accept), `assistant` 20, `upload` 30, `invitation` 20. Health, metrics and the SSE stream are exempt.
Responses past the limit: `429 rate_limited` with `Retry-After`.

## 1.2 Auth: session cookie + CSRF

- `kr_session`: httpOnly, `SameSite=Lax`, `Secure` in production. **Idle expiry 30 min, absolute 12 h.**
- `kr_csrf`: readable cookie. Echo it in **`X-CSRFToken`** on every POST/PUT/PATCH/DELETE (also on login).
- Flow: `GET /auth/csrf` (sets `kr_csrf`) → `POST /auth/login` → use the app. The client calls
  `POST /auth/refresh` at most every 5 minutes while the user is active; it rotates the session key and returns the
  new expiry. On `401 session_expired` the app goes to sign-in, keeping the current route for the return.
- Passwords: Argon2id; min 12 chars, common-password and similarity checks (`422 weak_password`).
- Login failures are generic (`401 invalid_credentials`); 5 failures for one email in 15 min locks that email for
  15 min (`429 rate_limited`). All auth events are audited.

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/auth/csrf` | – | `204` + `kr_csrf` cookie |
| POST | `/auth/signup` | `{ email, password, fullName, firmName, country: "AU"\|"GB" }` | `201 Me` (creates the firm and an `owner` membership) |
| POST | `/auth/login` | `{ email, password }` | `Me` |
| POST | `/auth/logout` | – | `204` |
| POST | `/auth/refresh` | – | `{ expiresAt, absoluteExpiresAt }` |
| GET | `/auth/me` | – | `Me` |
| POST | `/auth/switch-org` | `{ orgId }` | `Me` |
| POST | `/auth/password` | `{ currentPassword, newPassword }` | `204` (other sessions ended) |

```text
User      = { id, email, fullName, avatarColor, createdAt }
OrgSummary= { id, name, slug, country, role, roleLabel }
Me        = { user, activeOrg: Org | null, membership: { role, roleLabel, permissions: string[] } | null,
              orgs: OrgSummary[], session: { expiresAt, absoluteExpiresAt } }
```

## 1.3 Roles and permissions

| Permission | owner | compliance_officer | partner | fee_earner | auditor |
|---|:-:|:-:|:-:|:-:|:-:|
| `dashboard:read` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `insights:read` | ✓ | ✓ | ✓ | | ✓ |
| `clients:read` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `clients:write` | ✓ | ✓ | ✓ | ✓ | |
| `clients:onboard`, `identity:verify`, `edd:manage` | | ✓ | ✓ | ✓ | |
| `graph:read` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `graph:write` | | ✓ | ✓ | ✓ | |
| `resolution:read` | ✓ | ✓ | ✓ | | ✓ |
| `resolution:decide` | | ✓ | | | |
| `screening:read` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `screening:run` | | ✓ | ✓ | ✓ | |
| `screening:review` | | ✓ | | | |
| `risk:read` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `risk:assess` | | ✓ | ✓ | | |
| `risk:override`, `methodology:manage`, `models:promote` | | ✓ | | | |
| `models:read` | ✓ | ✓ | ✓ | | ✓ |
| `signoff:compliance` | | ✓ | | | |
| `signoff:senior` | | | ✓ | | |
| `monitoring:read` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `monitoring:manage` | | ✓ | | | |
| `concerns:raise` | ✓ | ✓ | ✓ | ✓ | |
| `smr:read`, `smr:write`, `smr:submit` | | ✓ | | | |
| `assistant:use` | ✓ | ✓ | ✓ | ✓ | |
| `audit:read` | ✓ | ✓ | | | ✓ |
| `training:read` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `training:manage` | ✓ | ✓ | | | |
| `retention:manage` | ✓ | ✓ | | | |
| `org:admin`, `members:manage` | ✓ | | | | |

Source of truth: `backend/accounts/roles.py` (unit-tested). Role labels: owner "Firm administrator",
compliance_officer "AML/CTF compliance officer", partner "Partner (senior manager)", fee_earner "Fee earner",
auditor "Independent reviewer".

**Tipping-off controls (ADR 0005).** No role alone grants access to a case's content. `smr:read` shows the case
register; each case also has an access list (`full` or `summary`). A user who is neither the compliance officer
nor on the list gets `404` for that case, sees no case-related events, badges, counts or audit rows, and the
assistant never reads case data. Concerns raised by staff return only an acknowledgement. Actions that could
alert a client while a case is open (requesting information from the client, exiting the client, closing the
matter) return `409 action_held` with neutral wording ("This step needs the compliance officer's go-ahead"),
identical to the wording used for other holds, so the response itself discloses nothing.

## 1.4 Organisation, members, invitations, settings

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/org` | any member | `Org` |
| PATCH | `/org` | `org:admin` | partial `{ name, abn, address, country, sector }` |
| GET | `/org/members` | any member | `Member[]` |
| PATCH | `/org/members/{id}` | `members:manage` | `{ role }` (cannot remove the last owner: `409 conflict`) |
| DELETE | `/org/members/{id}` | `members:manage` | `204` |
| GET | `/org/invitations` | `members:manage` | `Invitation[]` (open invitations only) |
| POST | `/org/invitations` | `members:manage` | `{ email, role }` → `{ invitation, inviteUrl }` (URL shown once; no email sent offline) |
| DELETE | `/org/invitations/{id}` | `members:manage` | revoke |
| GET | `/invitations/{token}` | public | `{ orgName, email, role, roleLabel, expiresAt }` |
| POST | `/invitations/{token}/accept` | public | `{ fullName, password }` (new user) or `{}` (signed in) → `Me` |
| GET | `/settings` | any member | `OrgSettings` |
| PATCH | `/settings` | `org:admin` or `retention:manage` (retention keys) or `methodology:manage` (review keys) | partial `OrgSettings` |
| GET | `/settings/retention/preview` | `retention:manage` | `?asOf=` → `RetentionPreview` (records due for disposal, dry run) |
| POST | `/settings/retention/run` | `retention:manage` | `{ dryRun: true }` default → `202 Job` |
| GET | `/training` | `training:read` | `TrainingRecord[]` (AML/CTF training register, whole firm, due date ascending) |
| POST | `/training` | `training:manage` | `{ userId, course, completedOn, evidenceNote? }` → `201 TrainingRecord` (`dueOn` = completedOn + 1 year) |

```text
Org          = { id, name, slug, country: "AU"|"GB", abn, address (one-line string), sector: "legal"|"accounting"|"conveyancing"|"real_estate"|"dealer",
                 regime: { name: "AML/CTF Act 2006 (Cth), Tranche 2" | "UK MLR 2017", commencement: "2026-07-01" | null },
                 dataResidency: "AU"|"UK", createdAt }
Member       = { id, userId, fullName, email, role, roleLabel, status: "active", joinedAt, trainingDueOn }
               (pending people are listed by /org/invitations, not here)
Invitation   = { id, email, role, roleLabel, expiresAt, acceptedAt, createdAt }
OrgSettings  = { retention: { years: 7, trigger: "relationship_end", legalHoldClientIds: string[] },
                 reviews: { highMonths: 12, mediumMonths: 24, lowMonths: 36 },
                 screening: { autoRescreenOnListUpdate: true, fuzzyThreshold: 0.82 },
                 ubo: { thresholdPct: 25 },
                 resolution: { autoMergeEnabled: true },
                 notifications: { criticalAlerts: "immediate"|"daily"|"off", reviewReminderDays: 30,
                                  signoffRequests: true, weeklyDigest: true, digestDay: "monday".."friday" } }
               PATCH sections: retention (org:admin or retention:manage); reviews, screening, ubo, resolution,
               notifications (org:admin or methodology:manage). Unknown sections → 422.
RetentionPreview = { asOf, dueCount, items: [{ recordType: "client"|"document"|"assessment"|"case", id, label,
                     relationshipEndedOn, disposableFrom, legalHold: boolean }] }
TrainingRecord   = { id, userId, fullName, course, completedOn, dueOn, status: "current"|"due_soon"|"overdue", evidenceNote }
                   (due_soon = due within 30 days)
```
Retention: minimum 7 years from the end of the business relationship for AU firms (AML/CTF Act record keeping),
5 years for UK firms (MLR 2017 reg 40); the API rejects lower values (`422`). Disposal is never automatic in the
demo: `run` with `dryRun:false` anonymises personal fields and keeps the audit chain intact.

## 1.5 Dashboard and insights

`GET /dashboard` (`dashboard:read`). Counts the caller may not see are omitted, never zeroed.
```json
{
  "fileTray": [{ "kind": "signoff"|"hit_review"|"merge_review"|"disagreement"|"alert"|"review_due",
                 "id": "…", "clientId": "…", "title": "Sign-off needed: Calder Family Trust",
                 "subtitle": "Senior approval · PEP in structure", "dueOn": "2025-10-20", "href": "/clients/…/risk" }],
  "counts": { "clients": 30, "highRisk": 6, "reviewsOverdue": 3, "reviewsDueSoon": 4, "screeningBacklog": 4,
              "mergeQueue": 7, "openAlerts": 5, "eddInProgress": 4, "awaitingSignoff": 3,
              "trainingOverdue": 1, "smrDrafts": 1 },
  "ratingMix": { "low": 15, "medium": 9, "high": 6 },
  "regime": { "name": "AML/CTF Act 2006 (Cth), Tranche 2", "commencement": "2026-07-01", "daysToCommencement": 260 },
  "recentActivity": [{ "id": 1, "action": "screening.hit_reviewed", "label": "Screening match reviewed for …",
                       "actorName": "Daniel Cho", "createdAt": "…" }]
}
```
`smrDrafts` appears only with `smr:read`. `fileTray` holds at most 6 items for the caller's role. Every `href` (tray
and insights) is a route in the web app: `/clients/{id}/{tab}`, `/screening/{hitId}`, `/fuse/{candidateId}`,
`/alerts/{alertId}`, `/board?lens=…`, `/clients?filter=needs`, `/settings/risk-method`. Subtitles are plain words
("Sanctions list · 85 in 100", "Compliance sign-off · nominee in structure"), never codes or percentages for
likelihoods.

`GET /insights` (`insights:read`) → `Insight[]` = `{ id, tone: "risk"|"progress"|"info", title, body, metric?: { value, unit, trend: "up"|"down"|"flat" }, href? }`.
Examples: "4 clients share a director who holds 41 other appointments", "Onboarding time fell from 6 to 3 days",
"Reviews overdue: 3 (all medium risk)", "Rules and the second-opinion model agree on 93% of clients".

## 1.6 Clients and onboarding (system of record)

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/clients` *(paged)* | `clients:read` | `?q=&kind=&rating=&status=&reviewDue=true&assignedTo=me` · order: name |
| POST | `/clients` | `clients:onboard` | `ClientCreate` → `Client` (status `onboarding`; first party created) |
| GET | `/clients/{id}` | `clients:read` | `Client` |
| PATCH | `/clients/{id}` | `clients:write` | partial `{ name, services, channel, assignedToId, matterReference }` |
| GET | `/clients/{id}/parties` | `clients:read` | `Party[]` in the structure |
| POST | `/clients/{id}/parties` | `graph:write` | `PartyCreate` → `Party` (adds to the structure) |
| PATCH | `/parties/{id}` | `graph:write` | partial `PartyCreate` |
| GET | `/parties/{id}` | `clients:read` | `Party` + `{ sourceRecords: PartyRecord[], clients: [{id,name}] }` |
| POST | `/relationships` | `graph:write` | `RelationshipCreate` → `Relationship` |
| PATCH | `/relationships/{id}` | `graph:write` | `{ pct?, role?, validFrom?, validTo?, evidenceNote? }` (ending = set `validTo`) |
| DELETE | `/relationships/{id}` | `graph:write` | only for data-entry mistakes (`reason` required); otherwise end it |
| GET | `/registry/search` | `clients:onboard` | `?source=uk_ch\|au_abr&q=` → `RegistryHit[]` |
| POST | `/clients/{id}/registry-import` | `graph:write` | `{ source, reference }` → `201 { partiesCreated, relationshipsCreated, job: Job \| null }` (import is synchronous; `job` = duplicate detection) |
| GET | `/clients/{id}/onboarding` | `clients:read` | `Onboarding` checklist |
| GET | `/clients/{id}/documents` | `clients:read` | `Document[]` newest first |
| POST | `/clients/{id}/documents` | `identity:verify` (`upload`) | multipart `file` (pdf/png/jpg ≤ 10 MB, sniffed by content), `partyId`, `docType` → `201 Document` |
| GET | `/documents/{id}/file` | `clients:read` | the file (`Content-Disposition: attachment`) |
| GET | `/clients/{id}/verification` | `clients:read` | `VerificationCheck[]` |
| POST | `/clients/{id}/verification` | `identity:verify` | `{ partyId, method: "document"\|"electronic", documentIds }` → `201 VerificationCheck` (safe-harbour style, mocked; electronic needs an `electronic_check` consent first) |
| GET | `/clients/{id}/consent` | `clients:read` | `Consent[]` |
| POST | `/clients/{id}/consent` | `clients:onboard` | `{ partyId, purpose: "identity_verification"\|"electronic_check", givenOn, method }` → `201 Consent` |
| POST | `/clients/{id}/submit` | `clients:onboard` | onboarding complete → `202 { client: Client, jobs: Job[] }` (screening + risk jobs); `422 invalid_transition` with the missing checklist items in `errors[].field` (item keys) |
| POST | `/clients/{id}/communications` | `clients:write` | `{ kind: "information_request"\|"exit_notice", message }` → `202 { id, status: "sent" }` or `409 action_held` |
| POST | `/clients/{id}/exit` | `clients:write` | `{ reason }` → `Client` or `409 action_held` |
| GET | `/clients/{id}/holds` | `signoff:compliance` | `{ active, holds: [{ id, reason: "manual"\|"restricted", note, placedByName, placedAt }] }` (active holds only) |
| POST | `/clients/{id}/holds` | `signoff:compliance` | `{ note }` → `201 { id, active }` (manual hold; same neutral wording as every hold) |
| POST | `/clients/{id}/holds/release` | `signoff:compliance` | `{ note }` → `{ released }` (releases every active hold on the client, including a case hold) |

```text
ClientKind = "individual" | "company" | "trust" | "partnership"
ClientCreate = { kind, name, jurisdiction, services: Service[], channel: "face_to_face"|"remote"|"intermediary",
                 matterReference?, assignedToId?, identifiers?: { acn?, abn?, ukCompanyNumber?, trustDeedDate? },
                 person?: { givenNames, familyName, birthDate, nationality, address } }
Service = "conveyancing" | "company_formation" | "trust_formation" | "property_transaction" | "managing_client_funds"
        | "tax_advice" | "audit" | "real_estate_sale" | "other"
Client  = { id, kind, name, status: "onboarding"|"active"|"blocked"|"exited", jurisdiction, partyId,
            services, channel, matterReference, assignedTo: { id, fullName } | null,
            rating: "low"|"medium"|"high"|null, ratingSource: "rules"|"override"|null, eddRequired: boolean,
            nextReviewOn, lastReviewedOn, onboardedOn, relationshipEndedOn, sample: boolean (seeded sample data),
            structure: { parties: number, layers: number, ubos: number },
            flags: ("pep"|"sanctions_review"|"offshore"|"circular"|"nominee"|"review_overdue")[],
            createdAt, updatedAt }
Address = { line1?, locality?, state?, postcode?, country? }      // AU postcodes are 4 digits
Party   = { id, kind: PartyKind, name, birthDate?, nationality?, jurisdiction?, identifiers: {acn?, abn?, ukCompanyNumber?},
            address?, isNominee: boolean, dormant?: boolean, source: "manual"|"uk_ch"|"au_abr"|"seed"|"import", sourceRef?,
            mergedInto: string | null, createdAt }
PartyCreate = { kind, name, birthDate?, nationality?, jurisdiction?, identifiers?, address?, isNominee? }
Relationship = { id, fromPartyId, toPartyId, kind: "ownership"|"control", pct?, interest?, role?, nominee: boolean,
                 validFrom, validTo, source, sourceRef?, evidenceNote?, createdAt }
RelationshipCreate = { fromPartyId, toPartyId, kind, pct? (ownership, 0<pct<=100), interest?, role? (control),
                       nominee?, validFrom, validTo?, evidenceNote? }
RegistryHit = { source, reference, name, kind, jurisdiction, status: "active"|"dissolved"|"dormant", address?, sample: boolean }
Onboarding = { clientId, status, items: [{ key, label, done: boolean, required: boolean, partyId?, href? }], canSubmit }
   item keys: "identity_<partyId>", "consent_<partyId>", "structure_confirmed", "ubos_identified",
              "screening_clear", "risk_assessed", "edd_complete" (when required), "signoff"
Document = { id, partyId, docType: "passport"|"drivers_licence"|"birth_certificate"|"trust_deed"|"company_extract"|"other",
             fileName, sizeBytes, sha256, uploadedBy, uploadedAt, retainUntil }
VerificationCheck = { id, partyId, method, result: "verified"|"partial"|"failed", sources: [{ name, matched: string[] }],
                      reference: "MOCK-DVS-…", checkedAt, demo: true }       // mocked; labelled as a demo check
Consent  = { id, partyId, purpose, givenOn, method, recordedBy }
```
Validation: ownership into one entity may not exceed 100% for overlapping validity (`422 over_allocated`); a
party cannot own itself directly; cycles through other entities are allowed (and flagged by the graph).

## 1.7 Graph (Sigma.js / graphology)

Graph payloads use the **graphology serialisation** so the web app can `graph.import(payload)` directly:
```json
{
  "attributes": { "focusId": "…", "asOf": "2025-10-01", "depth": 6, "truncated": false, "graphVersion": 418 },
  "nodes": [{ "key": "…", "attributes": {
      "label": "Bellmere Holdings Pty Ltd", "kind": "company", "jurisdiction": "AU",
      "identifiers": { "acn": "612 345 678" }, "flags": ["ubo"], "clientId": null, "riskRating": null,
      "level": 2, "effectivePct": null, "mergedCount": 0 } }],
  "edges": [{ "key": "…", "source": "…", "target": "…", "attributes": {
      "kind": "ownership", "label": "62%", "pct": 62, "interest": "shares", "role": null, "nominee": false,
      "validFrom": "2019-06-01", "validTo": null, "sourceRef": "manual" } }]
}
```
Node `kind`: person (circle), company (rectangle), trust / partnership (rounded rect with fold), address, and two
**group nodes** added by the client graph (never stored): `unknown` ("Unknown shareholders": an undisclosed holder
on the register, or `unknown:<partyId>` for the share of an entity nobody has declared, linked by an ownership edge
`unknown-edge:<partyId>` with `pct: null` and `label` = the missing share or "?%") and `stack` (`stack:<partyId>`,
"43 companies": an officer's appointments outside the structure, with `count` and `sub` "Dormant" / "Other
appointments", linked by a control edge labelled "Directs"). Group nodes carry `count` and `sub` attributes.
**Edge order is stable**: links nearest the focus first, then ownership before control before addresses, larger
holdings first, then names. The web app numbers edges `E-01`, `E-02` … in payload order, so the same structure
always gets the same citation numbers.
Edge `kind`: `ownership` (solid, % label, owner → owned), `control` (dashed, role label, controller → entity),
`address` (party → address). Node flags: `client, ubo, pep, sanctions_hit, nominee, offshore,
high_risk_jurisdiction, dormant, unknown_owner, circular, merged`. Positions are computed in the browser
(`level` is a layering hint; 0 = focus).

| Method | Path | Permission | Response |
|---|---|---|---|
| GET | `/clients/{id}/graph?asOf=&depth=6` | `graph:read` | graphology payload |
| GET | `/parties/{id}/graph?asOf=&depth=2` | `graph:read` | graphology payload (expand a node) |
| GET | `/clients/{id}/ubo?asOf=` | `graph:read` | `UboResult` |
| GET | `/clients/{id}/graph/diff?from=&to=` | `graph:read` | `GraphDiff` |
| GET | `/parties/{id}/thread?asOf=` | `graph:read` | `ThreadResult` ("pull the thread") |
| GET | `/graph/connection?from=&to=&asOf=` | `graph:read` | `ConnectionResult` |
| GET | `/graph/search?q=&limit=10` | `graph:read` | `GraphNode[]` (search pill; clients first) |
| GET | `/graph/clusters?kind=` | `graph:read` | `Cluster[]` |
| GET | `/graph/constellation` | `graph:read` | graphology payload of the whole book (home screen) |
| GET | `/graph/status` | `graph:read` | `{ graphVersion, pending, lastAppliedAt }` |

```text
PathHop    = { edgeId, fromId, toId, kind, pct?, role? }
GraphPath  = { nodeIds, hops: PathHop[], effectivePct?, sentence }
BeneficialOwner = { partyId, name, kind, effectivePct?, via: "ownership"|"control"|"both", controlRoles,
                    isUbo, paths: GraphPath[], explanation }
UboResult  = { clientId, asOf, thresholdPct, owners: BeneficialOwner[], unexplainedPct, cycles: string[][],
               warnings: ("circular_ownership"|"unknown_owner"|"depth_limit"|"over_allocated"|"nominee_in_chain")[], computedAt }
EdgeChange = { before: GraphEdge, after: GraphEdge, fields: string[] }
GraphDiff  = { clientId, fromDate, toDate, added: GraphEdge[], removed: GraphEdge[], changed: EdgeChange[],
               nodesAdded: GraphNode[], nodesRemoved: GraphNode[], summary: string[] }
ThreadResult = { partyId, asOf, entries: [{ clientId, clientName, effectivePct?, roles, paths: GraphPath[] }], nodeIds, edgeIds }
ConnectionResult = { fromId, toId, found, paths: GraphPath[] }       // shortest first, ≤ 3
Cluster    = { id, kind: "shared_officer"|"shared_address"|"nominee", label, reason, partyIds, clientIds, size }
GraphNode / GraphEdge (non-graphology lists, e.g. diff and search) = the node/edge attributes plus `id`
(and `source`/`target` for edges): see backend/kinroot/contracts.py
```
Example explanation: *"Ava Calder controls 49.6% of Harbour Quay Developments Pty Ltd: 100% of the Calder
Family Trust, which holds 62% of Bellmere Holdings Pty Ltd, which owns 80% of Kestrel Ventures Ltd (British
Virgin Islands), the 100% owner."* UBO rule: effective ownership ≥ `thresholdPct` (25) **or** control
(trustee, appointor, director of a corporate trustee, significant control, nominee for). Effective % sums every
simple path; cycles are reported in `cycles` and never looped.

## 1.8 Entity resolution: match pairs and the merge/split queue

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/resolution/candidates` *(paged)* | `resolution:read` | `?status=pending&band=&clientId=` · order: probability desc |
| GET | `/resolution/candidates/{id}` | `resolution:read` | `MatchCandidate` |
| POST | `/resolution/candidates/{id}/decision` | `resolution:decide` | `{ decision: "merge"\|"not_match"\|"defer", note }` → `MergeOutcome`; `409 already_decided` |
| POST | `/resolution/propose` | `graph:write` | `{ leftId, rightId }` → `MatchCandidate` (drag-to-fuse) |
| POST | `/parties/{id}/split` | `resolution:decide` | `{ recordIds, note }` → `MergeOutcome` |
| GET | `/resolution/thresholds` | `resolution:read` | `Thresholds` |
| GET | `/resolution/stats` | `resolution:read` | `{ pending, autoMergedLast30d, decidedLast30d, reviewRate }` |

```text
PartyRecord  = { id, kind, name, birthDate?, nationality?, jurisdiction?, identifiers, address?, source, sourceRef? }
MatchReason  = { feature, label, direction: "for"|"against", contribution, value }
MatchScore   = { probability, band: "auto_merge"|"review"|"reject", fsWeight, fsProbability,
                 features: { name_jaro_winkler: 0.97, name_token_set: 1.0, name_phonetic_agree: 1, dob_exact: 1,
                             dob_partial: 1, dob_transposed: 0, id_agree: -1, address_token_overlap: 0.62,
                             postcode_agree: 1, nationality_agree: 1, jurisdiction_agree: 1, kind_agree: 1 },
                 reasons: MatchReason[] (top 5 by |contribution|), modelVersion }
MatchCandidate = { id, status: "pending"|"merged"|"auto_merged"|"not_match"|"deferred", left: PartyRecord,
                   right: PartyRecord, score: MatchScore, clientIds, createdAt, decidedBy?, decidedAt?, note? }
MergeOutcome = { candidateId?, survivorId, mergedIds, status }
Thresholds   = { autoMerge: 0.97, review: 0.40, modelVersion, chosenBy, expectedReviewRate }
```
Feature values: similarities 0..1; agreement flags 1 = agree, 0 = disagree, -1 = missing. Reason labels are plain
language ("Same date of birth", "Names are almost identical", "Different company numbers").

## 1.9 Screening

| Method | Path | Permission | Notes |
|---|---|---|---|
| POST | `/clients/{id}/screen` | `screening:run` | → `Job` (result in `ScreeningRunResult`) |
| GET | `/screening/hits` *(paged)* | `screening:read` | `?status=pending&clientId=&list=` · order: score desc |
| GET | `/screening/hits/{id}` | `screening:read` | `ScreeningHit` |
| POST | `/screening/hits/{id}/review` | `screening:review` | `{ decision: "true_match"\|"false_positive"\|"escalate", reason (≥10 chars) }` → `ScreeningHit`; `409 already_decided` |
| GET | `/screening/lists` | `screening:read` | `[{ list, source, version, entries, loadedAt, sample: boolean }]` |
| POST | `/screening/rescreen` | `monitoring:manage` | whole book → `Job` |

```text
ListEntry    = { id, listKind: "sanctions"|"pep"|"adverse_media", name, aliases, birthDate?, countries, programs, source, url? }
ScreeningHit = { id, clientId, partyId, partyName, entry: ListEntry, score, reasons: MatchReason[],
                 status: "pending"|"true_match"|"false_positive"|"escalated", createdAt, reviewedBy?, reviewedAt?, reviewReason? }
ScreeningRunResult = { runId, clientId?, screenedParties, newHits, listVersions }
```
`true_match` on a sanctions list blocks the client (`status: blocked`, `423 client_blocked` on further work) and
raises a critical alert; on a PEP list it adds the `pep` EDD trigger. `escalate` raises an internal concern.
Fee earners see hit **status** on their clients but `reviewReason` only once decided.

## 1.10 Risk: rules of record, ML challenger, EDD, sign-off

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/clients/{id}/risk` | `risk:read` | `RiskAssessment \| null` (latest) |
| GET | `/clients/{id}/risk/history` | `risk:read` | `RiskAssessment[]` newest first |
| POST | `/clients/{id}/risk/assess` | `risk:assess` | → `RiskAssessment` |
| POST | `/clients/{id}/risk/override` | `risk:override` | `{ rating, reason }` (lowering needs ≥ 20 chars) → `RiskAssessment` |
| GET | `/risk/disagreements` *(paged)* | `risk:read` | `?status=open` |
| POST | `/risk/disagreements/{id}/resolve` | `risk:override` | `{ outcome: "keep_rules"\|"override_to_challenger"\|"methodology_issue", note }` |
| GET | `/risk/methodology` | `risk:read` | `Methodology[]` |
| POST | `/risk/methodology/{id}/publish` | `methodology:manage` | publishes a draft; previous → retired |
| GET | `/models` | `models:read` | `ModelEntry[]` (ER matcher + risk challenger) as seen by the caller's firm |
| POST | `/models/{name}/promote` | `models:promote` | `{ version, note }` → `ModelEntry` (champion/challenger sign-off for **this firm only**: another firm's champion, scoring and drift are unaffected) |
| GET | `/clients/{id}/edd` | `risk:read` | `Edd` |
| POST | `/clients/{id}/edd/measures/{key}` | `edd:manage` | `{ status: "done"\|"not_applicable", note, documentIds? }` → `Edd` |
| POST | `/clients/{id}/signoff` | `signoff:compliance` or `signoff:senior` (per stage) | `{ stage: "compliance"\|"senior", decision: "approve"\|"reject", note }` → `Edd` |
| GET | `/signoffs?stage=` | `signoff:compliance` or `signoff:senior` | queue: `[{ clientId, clientName, stage, rating, triggers, waitingSince, ownClient }]` oldest first |

```text
RiskReason   = { code, factor: "customer"|"structure"|"jurisdiction"|"service"|"channel"|"screening", points, message,
                 evidence: [{ type: "edge"|"node"|"hit"|"document", id }] }
Challenger   = { modelVersion, probabilityHigh, rating, agreement: "agree"|"disagree", reasons: MatchReason[], disagreementId? }
EddTrigger   = { code, message, measures: string[] }
RiskAssessment = { id, clientId, methodologyVersion, score (0..100), rating, reasons: RiskReason[], challenger: Challenger | null,
                   eddRequired, eddTriggers: EddTrigger[], inputsHash, assessedAt, override: { rating, reason, byName, at } | null }
Methodology  = { id, version: "KR-RM-1.2", status: "draft"|"published"|"retired", publishedAt?, publishedBy?,
                 bands: { medium: 30, high: 60 }, rules: [{ code, factor, description, points, condition }] }
ModelEntry   = { name: "er-matcher"|"risk-challenger", versions: [{ version, stage: "champion"|"challenger"|"retired",
                 trainedAt, metrics: { … }, calibration: { brier, ece }, drift: { psi, status: "stable"|"watch"|"drift" },
                 modelCard (markdown), runId, promotedBy?, promotedAt? }] }
Edd          = { clientId, required, triggers: EddTrigger[], measures: [{ key, label, status: "todo"|"done"|"not_applicable",
                 note?, documentIds, completedBy?, completedAt? }],
                 signoffs: [{ stage, decision, note, byName, at }], status: "not_required"|"in_progress"|"awaiting_compliance"|"awaiting_senior"|"approved"|"rejected" }
```
Measure keys: `source_of_wealth`, `source_of_funds`, `senior_approval`, `ubo_verification`, `purpose_of_relationship`,
`adverse_media_check`, `enhanced_monitoring`. Measure `status` may be set back to `todo`; `not_applicable` needs a note of
≥ 10 characters; `senior_approval` is completed only by the senior sign-off (`422` if posted). A rejection needs a note
≥ 10 characters; changing a measure after a rejection reopens the file (earlier sign-offs are superseded). Order: compliance sign-off, then senior (partner) approval when a
trigger requires it (PEP, high rating, high-risk jurisdiction). A partner cannot approve their own client's file.

## 1.11 Ongoing monitoring

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/monitoring/alerts` *(paged)* | `monitoring:read` | `?status=open&kind=&clientId=` · order: severity, createdAt desc |
| GET | `/monitoring/alerts/{id}` | `monitoring:read` | `Alert` |
| POST | `/monitoring/alerts/{id}/resolve` | `monitoring:manage` | `{ outcome: "resolved"\|"dismissed", note }` |
| GET | `/monitoring/reviews` | `monitoring:read` | `?dueBefore=` → `[{ clientId, clientName, rating, lastReviewedOn, nextReviewOn, overdueDays, assignedToName }]` |
| POST | `/clients/{id}/review` | `monitoring:manage` | `{ dueOn }` (re)schedule; `{ completed: true, note }` records a completed review |

```text
Alert = { id, clientId, clientName, kind: "list_update_hit"|"ownership_change"|"officer_change"|"address_change"|"risk_change"|"review_due"|"model_drift",
          severity: "info"|"warning"|"critical", title, body, evidence: [{ type, id }], status: "open"|"resolved"|"dismissed",
          createdAt, resolvedBy?, resolvedAt?, resolutionNote? }
```

## 1.12 Concerns, cases and suspicious-matter reports (restricted)

| Method | Path | Permission | Notes |
|---|---|---|---|
| POST | `/concerns` | `concerns:raise` | `{ clientId?, summary, details }` → `201 { id, receivedAt, message }` only |
| GET | `/concerns` | `smr:read` | triage list `[{ id, clientId, clientName, raisedByName, summary, details, status, caseId, receivedAt }]` |
| GET | `/concerns/mine` | `concerns:raise` | `[{ id, receivedAt, status: "received" }]` (never the outcome) |
| GET | `/cases` *(paged)* | any member | only cases the caller can see (compliance officer: all; others: those on whose access list they are; otherwise an empty page) |
| POST | `/cases` | `smr:write` | `{ clientId, title, concernIds?, grounds, terrorismFinancing? }` → `201 Case` (places a neutral hold on the client) |
| GET | `/cases/{id}` | access list | `Case`; `404` without access |
| PATCH | `/cases/{id}` | `smr:write` + full access | `{ title?, grounds?, status?: "open"\|"closed_no_report" }` (closing releases the case hold) |
| PUT | `/cases/{id}/access` | `smr:write` | `{ entries: [{ userId, level: "full"\|"summary" }] }` |
| GET | `/cases/{id}/smr` | access list | `SmrDraft` (version 0 when nothing saved yet; summary access gets the redacted draft) |
| PUT | `/cases/{id}/smr` | `smr:write` + full | `SmrDraft` fields; `409 stale_version` on `version` mismatch |
| POST | `/cases/{id}/smr/submit` | `smr:submit` + full | → `{ reference: "DEMO-SMR-…", submittedAt }` (mock regulator portal); `422` until suspicionGrounds, narrative and subjects are filled; `409 conflict` when already submitted |
| GET | `/cases/{id}/timeline` | access list | `[{ at, actorName, action, label }]` |

```text
Case     = { id, clientId, clientName, title, status: "open"|"reported"|"closed_no_report", grounds | null (redacted for summary),
             accessLevel: "full"|"summary", redactedFields: string[], openedBy, openedAt, deadlineOn, smrStatus: "none"|"draft"|"submitted",
             access: [{ userId, fullName, level }] (full only) }
SmrDraft = { caseId, version, regime: "AUSTRAC_SMR"|"UK_SAR", suspicionGrounds, subjects: [{ partyId, name, role }],
             transactions: [{ date, amount, currency, description }], narrative, attachments: string[], updatedBy, updatedAt,
             submittedAt, reference, redactedFields: string[] }
           PUT body: { version (must equal the current version), suspicionGrounds?, subjects?: [{ partyId, role }],
                       transactions?, narrative?, attachments? } → the saved draft with version + 1
```
AU SMRs are due within 3 business days (24 hours for terrorism financing) of forming the suspicion: `deadlineOn`.
Redaction: `summary` access returns the case with `grounds: null`, `narrative` withheld and `redactedFields`
naming them, so the UI can show redaction bars only to users who already know the case exists. On the SMR draft,
summary access nulls `suspicionGrounds` and `narrative` and empties `transactions` (`redactedFields` names them).
Summary members may read, never write (`403`). The compliance officer always has full access.

## 1.13 Investigation assistant

| Method | Path | Permission | Notes |
|---|---|---|---|
| POST | `/assistant/ask` | `assistant:use` (`assistant`) | `{ question (≤500), clientId?, asOf? }` → `AssistantAnswer` |
| GET | `/assistant/history?clientId=` | `assistant:use` | `AssistantAnswer[]` (caller's own) |
| GET | `/assistant/suggestions?clientId=` | `assistant:use` | `string[]` |
| POST | `/assistant/answers/{id}/pin` | `assistant:use` | `{ clientId }` → `201 { answerId, clientId, pinnedAt }` (own grounded answers only; `404` otherwise) |
| GET | `/clients/{id}/pins` | `clients:read` | `[{ id, question, answer, citations, pinnedByName, pinnedAt }]` newest first (shown in the dossier Timeline) |

```text
Citation      = { type: "edge"|"node"|"hit"|"alert", id, label }
AssistantStep = { tool: "find_party"|"who_controls"|"path_between"|"changes_since"|"screening_status"|"risk_reasons",
                  label, args, resultCount }
AssistantAnswer = { id, question, answer, citations: Citation[], steps: AssistantStep[],
                    highlight: { nodeIds: string[], edgeIds: string[] }, mode: "offline"|"cloud", createdAt, grounded,
                  graph: graphology payload | null }   // exactly the highlighted parties and links, as at the answer's date
```
`answer` sentences end with `[1]`, `[2]` markers indexing `citations`. When the draft is not fully grounded,
`grounded: false` and `answer` is a safe message ("I couldn't confirm that from the ownership records").
Step labels are business language ("Traced the owners of Harbour Quay Developments").

## 1.14 Audit, jobs, events, health

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/audit` *(paged)* | `audit:read` | `?action=&actorId=&resourceType=&resourceId=&from=&to=` → `AuditEntry` newest first (`action=screening.` with a trailing dot filters by area) |
| GET | `/audit/verify` | `audit:read` | `{ valid, checked, brokenAt }` |
| GET | `/audit/export.csv` | `audit:read` | CSV |
| GET | `/jobs/{id}` | any member (own org) | `Job` |
| GET | `/events/stream` | any member | SSE (below) |
| GET | `/health` · `/health/ready` · `/metrics` (root, no auth) | – | liveness · readiness · Prometheus |

```text
AuditEntry = { id, action, label, actorName, actorType: "user"|"system", resourceType, resourceId, metadata, ip, createdAt, hash, prevHash }
Job        = { id, kind, status: "queued"|"running"|"succeeded"|"failed", progress: 0..100, result?, error?, createdAt, finishedAt? }
```
Restricted audit rows (case actions) are listed only to users with `smr:read`; they stay in the hash chain.

### SSE events
`GET /api/v1/events/stream` (cookie auth; `Last-Event-ID` or `?lastEventId=` resumes; without either the stream starts
at the newest event). The server closes the stream every 5 minutes and the browser reconnects with `Last-Event-ID`
(`retry: 3000`). Each event:
`id: <monotonic int>` · `event: <name>` · `data: <json>`; a `heartbeat` comment every 15 s. Events are org-scoped
and filtered by the recipient's permissions; restricted case events go only to users on the case access list.

| Event | Data | Audience |
|---|---|---|
| `job.updated` | `{ jobId, kind, status, progress }` | job creator |
| `graph.synced` | `{ graphVersion, clientIds }` | `graph:read` |
| `screening.hit` | `{ hitId, clientId, list, score }` | `screening:read` |
| `screening.reviewed` | `{ hitId, clientId, status }` | `screening:read` |
| `resolution.candidate` | `{ candidateId, band }` | `resolution:read` |
| `resolution.merged` | `{ survivorId, mergedIds }` | `graph:read` |
| `risk.assessed` | `{ clientId, rating, agreement }` | `risk:read` |
| `edd.updated` | `{ clientId, status }` | `risk:read` |
| `alert.raised` | `{ alertId, clientId, kind, severity }` | `monitoring:read` |
| `review.due` | `{ clientId, nextReviewOn }` | `monitoring:read` |
| `case.updated` | `{ caseId, status }` | case access list only |
| `heartbeat` | `{}` | all |

---

# Part 2: Data model (Django ORM; SQLite default, Postgres-ready)

Every tenant table has `org` (FK, indexed) and every query filters by the request's active org. UUID primary
keys except append-only logs (BigAutoField). `created_at`/`updated_at` on all.

| App | Model | Key fields |
|---|---|---|
| accounts | `User` | email (unique), full_name, avatar_color, password (argon2) |
| | `Organisation` | name, slug, country, abn, address, sector, settings (JSON: `OrgSettings`) |
| | `Membership` | org, user, role, joined_at; unique (org, user) |
| | `Invitation` | org, email, role, token_hash (HMAC), expires_at, accepted_at, invited_by |
| | `TrainingRecord` | org, user, course, completed_on, due_on, evidence_note |
| audit | `AuditLog` | org, actor, actor_type, action, resource_type, resource_id, metadata, ip, user_agent, restricted, prev_hash, hash |
| jobs | `Job` | org, kind, payload, status, priority, run_at, attempts, max_attempts, locked_by, locked_until, dedupe_key, result, error, progress, created_by |
| | `Event` | org, name, data, permission, user_ids (JSON), created_at (BigAutoField id = SSE id) |
| clients | `Client` | org, kind, name, status, party (FK Party), jurisdiction, services, channel, matter_reference, assigned_to, rating, rating_source, edd_required, onboarded_on, last_reviewed_on, next_review_on, relationship_ended_on, legal_hold, submitted_at, ubo_count (cache), blocked_reason, seed_key (stable sample id, unique per org) |
| | `Party` | org, kind, name, normalized_name, given_names, family_name, birth_date, nationality, jurisdiction, identifiers (JSON), address (JSON), is_nominee, dormant, source, source_ref, merged_into (FK self) |
| | `ClientParty` | org, client, party (membership of a party in a client's structure; maintained from relationships) |
| | `Relationship` | org, from_party, to_party, kind, pct, interest, role, nominee, valid_from, valid_to, source, source_ref, evidence_note |
| | `Document` | org, client, party, doc_type, file, sha256, size, uploaded_by, retain_until |
| | `VerificationCheck`, `Consent` | per §1.6 |
| | `EddCase`, `EddMeasure`, `SignOff` | per §1.10 (`Edd` shape) |
| | `Communication` | org, client, kind, message, status (sent/held), held_reason_code |
| | `ClientHold` | org, client, reason_code (manual/restricted), source_ref, note, placed_by, released_at, released_by |
| cases | `Concern` | org, client, raised_by, summary, details, status |
| | `Case` | org, client, title, grounds, status, opened_by, deadline_on |
| | `CaseAccess` | case, user, level |
| | `SmrDraft` | case, version, regime, payload (JSON), submitted_at, reference |
| graph | `GraphOutbox` | seq (BigAutoField), org, entity ("party"/"relationship"), entity_id, op ("upsert"/"delete"), applied_at |
| | `GraphSyncState` | org, graph_version, last_applied_at |
| resolution | `MatchCandidate` | org, left, right (Party; ordered pair unique), probability, band, fs_weight, features, reasons, model_version, status, decided_by, decided_at, note |
| | `MergeRecord` | org, survivor, merged (Party), candidate, actor, undone_at (split) |
| screening | `ListVersion` | list_kind, source, version, entries, loaded_at, is_sample |
| | `ListEntry` | version, entry_id, list_kind, name, aliases, birth_date, countries, programs, identifiers, url |
| | `ScreeningRun` | org, client (nullable), reason, list_versions, screened, new_hits |
| | `ScreeningHit` | org, client, party, entry, score, reasons, status, reviewed_by, reviewed_at, review_reason; unique (party, entry_id) |
| risk | `RiskMethodology` | org, version, status, bands, rules (JSON), published_by, published_at |
| | `RiskAssessment` | org, client, methodology, score, rating, reasons, features (JSON), challenger (JSON), edd_triggers, inputs_hash, override (JSON) |
| | `Disagreement` | org, assessment, rules_rating, challenger_rating, probability_high, status, outcome, note, resolved_by |
| | `ModelPromotion` | org (the firm that signed off; champions are per firm), model_name, version, stage, promoted_by, note (MLflow holds runs/metrics) |
| monitoring | `Alert` | org, client, kind, severity, title, body, evidence, status, resolved_by, resolution_note |
| | `ReviewSchedule` | org, client, due_on, completed_on, completed_by, note |
| assistant | `AssistantExchange` | org, user, client, question, answer, citations, steps, mode, grounded, pinned_client, pinned_by, pinned_at |

---

# Part 3: Python interfaces between the platform/API layer and the domain core

All shared dataclasses live in **`backend/kinroot/contracts.py`** (frozen; listed fields mirror Part 1).
Each domain app exposes one public module, **`<app>/api.py`**; the HTTP views import only those. Domain code never
imports views or serializers. Changing a signature means changing this section in the same commit.

### The API layer calls the domain core
```python
# graph/api.py
client_graph(org_id, client_id, *, as_of=None, depth=6) -> GraphView
party_graph(org_id, party_id, *, as_of=None, depth=2) -> GraphView
beneficial_owners(org_id, client_id, *, as_of=None, threshold_pct=None) -> UboResult
pull_thread(org_id, party_id, *, as_of=None) -> ThreadResult
graph_diff(org_id, client_id, from_date, to_date) -> GraphDiff
connection(org_id, from_party_id, to_party_id, *, as_of=None, max_hops=6) -> ConnectionResult
clusters(org_id, *, kinds=None, min_size=3) -> list[Cluster]
constellation(org_id) -> GraphView
search(org_id, q, *, limit=10) -> list[GraphNode]
subgraph(org_id, node_ids, edge_ids, *, as_of=None) -> GraphView   # exactly these parties/links (assistant answers)
graph_features(org_id, client_id, *, as_of=None) -> GraphFeatures
rebuild_org(org_id) -> int                      # seed + bulk imports
apply_pending(limit=500) -> int                  # worker job "graph.sync"
sync_status(org_id) -> SyncStatus

# resolution/api.py
score_pair(left: PartyRecord, right: PartyRecord) -> MatchScore
find_candidates(org_id, *, party_ids=None) -> int
list_candidates(org_id, *, status="pending", band=None, client_id=None, offset=0, limit=25) -> Page[MatchCandidateView]
get_candidate(org_id, candidate_id) -> MatchCandidateView
decide(org_id, candidate_id, decision, actor: Actor, note="") -> MergeOutcome      # DomainConflict("already_decided")
propose_merge(org_id, left_id, right_id, actor) -> MatchCandidateView
split(org_id, party_id, record_ids, actor, note) -> MergeOutcome
thresholds(org_id=None) -> Thresholds       # of the firm's champion matcher
queue_stats(org_id) -> dict

# screening/api.py
screen_client(org_id, client_id, actor) -> ScreeningRunResult
screen_org(org_id, actor, *, reason="list_update") -> ScreeningRunResult
list_hits(org_id, *, status="pending", client_id=None, list_kind=None, offset=0, limit=25) -> Page[ScreeningHitView]
get_hit(org_id, hit_id) -> ScreeningHitView
review_hit(org_id, hit_id, decision, reason, actor) -> ScreeningHitView
list_versions() -> list[dict]; get_entry(entry_id) -> ListEntryView; load_lists(*, source=None) -> dict

# risk/api.py
assess_client(org_id, client_id, actor) -> RiskAssessmentView
assess_org(org_id, actor) -> int
latest_assessment(org_id, client_id) -> RiskAssessmentView | None
assessment_history(org_id, client_id) -> list[RiskAssessmentView]
override_rating(org_id, client_id, rating, reason, actor) -> RiskAssessmentView
edd_requirements(org_id, client_id) -> list[EddTrigger]
list_disagreements(org_id, *, status="open", offset=0, limit=25) -> Page[dict]
resolve_disagreement(org_id, disagreement_id, outcome, note, actor) -> dict
methodology_versions(org_id) -> list[dict]; publish_methodology(org_id, methodology_id, actor) -> dict
model_registry(org_id=None) -> list[dict]; promote_model(model_name, version, actor, note) -> dict  # per-firm champion
model_drift(org_id=None) -> dict                                                                     # PSI of one firm's book

# monitoring/api.py
list_alerts(org_id, *, status="open", kind=None, client_id=None, offset=0, limit=25) -> Page[AlertView]
get_alert(org_id, alert_id) -> AlertView
resolve_alert(org_id, alert_id, outcome, note, actor) -> AlertView
review_schedule(org_id, *, due_before=None) -> list[dict]
schedule_review(org_id, client_id, due, actor) -> dict
run_daily(org_id) -> dict[str, int]
on_structure_changed(org_id, client_ids, changed_edge_ids) -> int

# assistant/api.py
ask(org_id, question, actor, *, permissions: frozenset[str], client_id=None, as_of=None) -> AssistantAnswer
history(org_id, user_id, *, client_id=None, limit=20) -> list[AssistantAnswer]
pin(org_id, answer_id, client_id, actor) -> dict; pinned(org_id, client_id) -> list[dict]
suggested_questions(org_id, client_id=None) -> list[str]
```
Errors: the domain core raises `contracts.NotFound` (→ 404) and `contracts.DomainConflict(code, detail)` (→ 409 with
that code); `ValueError` with a message for invalid input (→ 422).

### The domain core calls the platform
```python
# audit/api.py
record(actor: Actor, action, *, resource_type=None, resource_id=None, metadata=None, restricted=False) -> int
verify_chain(org_id) -> dict
# jobs/api.py
register(kind, *, max_attempts=3, timeout_s=300)          # decorator for handlers(payload) -> dict | None
enqueue(kind, payload, *, org_id, run_at=None, dedupe_key=None, priority=100) -> UUID
publish_event(org_id, event, data, *, permission=None, user_ids=None) -> int
set_progress(job_id, progress) -> None                   # optional; handlers receive payload["jobId"]
# clients/api.py
party_records(org_id, *, party_ids=None, active_only=True) -> list[PartyRecord]
client_party_ids(org_id, client_id) -> list[UUID]
merge_parties(org_id, survivor_id, merged_ids, actor) -> None
split_party(org_id, survivor_id, record_ids, actor) -> list[UUID]
set_client_rating(org_id, client_id, rating, assessed_on, *, source="rules"|"override", edd_triggers=None) -> None
    # fills next_review_on from the org's review months when empty; edd_triggers aligns the EDD workflow
set_review_dates(org_id, client_id, *, last_reviewed_on=None, next_review_on=None) -> None
block_client(org_id, client_id, reason_code, actor) -> None
# cases/api.py
raise_concern(org_id, client_id, summary, details, actor) -> UUID   # e.g. screening "escalate"; restricted audit row
# accounts/services.py
org_settings(org_id) -> dict                             # OrgSettings, snake_case keys, defaults merged
# read-only model access: domain apps may query clients.models.Client/Party/Relationship directly (never write them).
```

### Job kinds
| Kind | Registered by | Enqueued by |
|---|---|---|
| `graph.sync` | graph | API on commit (outbox non-empty) and a 1 s worker tick |
| `screening.client` / `screening.rescreen_org` | screening | API (submit, `/screen`), screening (list update) |
| `risk.assess_client` | risk | API (submit), domain (structure change, hit decision) |
| `resolution.find_candidates` | resolution | API (party created/imported), seed |
| `monitoring.daily` | monitoring | worker scheduler (daily) |
| `retention.run` | clients | `/settings/retention/run` |
| `registry.import` | clients | `/clients/{id}/registry-import` |

### Graph writer rule (ADR 0002)
`GRAPH_WRITER=worker`: only the worker opens the graph read-write; the API opens it read-only and reopens when
`graph_version` changes. `GRAPH_WRITER=inline`: the current process applies the outbox synchronously after commit
(tests, `make seed`, single-process runs). Never run two read-write processes.

---

# Part 4: Module map

| Area | Paths |
|---|---|
| Platform: settings, core (errors, middleware, logging, metrics, pagination, throttling, camelCase), URL map | `backend/kinroot/**` |
| Shared dataclasses and public domain interfaces (Part 3) | `backend/kinroot/contracts.py`, `backend/*/api.py` |
| Accounts, auth, sessions, RBAC, invitations, settings, training register | `backend/accounts/**` |
| HTTP API (views, serializers, URL routing, SSE stream) | `backend/api/**` |
| Audit trail (per-organisation hash chain) | `backend/audit/**` |
| Jobs queue, worker command, event outbox | `backend/jobs/**` |
| Clients system of record, onboarding, documents, verification (mock), consent, EDD workflow and sign-off, holds, registry import, retention | `backend/clients/**` |
| Demo seed and reset commands | `backend/clients/management/commands/seed_demo.py`, `reset_demo.py` |
| Concerns, cases, SMR drafting, case access | `backend/cases/**` |
| Graph store (LadybugDB, Neo4j adapter), sync, UBO, paths, diff, clusters, features | `backend/graph/**` |
| Entity resolution: normalisation, blocking, features, Fellegi-Sunter, LightGBM matcher, training, thresholds, SHAP | `backend/resolution/**` |
| Screening lists, matcher, bundled sample lists, attribution | `backend/screening/**` |
| Risk rules methodology, EDD triggers, challenger model and training, model registry | `backend/risk/**` |
| Monitoring, review schedule, alerts | `backend/monitoring/**` |
| Investigation assistant (graph tools, offline planner, optional cloud adapter) | `backend/assistant/**` |
| Committed model artifacts and model cards | `backend/artifacts/models/**` |
| Tests: platform, API, domain, graph, ML | `backend/tests/**` |
| Evaluation harness, gates and results | `eval/**` |
| Public data downloaders and the graph smoke check | `scripts/**` |
| Web app | `frontend/**` |

Migrations live with their app. New dependencies are pinned exactly and frozen in `backend/requirements.lock`
(`make lock`).

---

# Part 5: Demo seed (`make seed`)

Seeded by `python manage.py seed_demo` (idempotent; `make reset` drops and re-seeds). All data is synthetic and
labelled "Sample data" in the UI. Dates are relative to the day the seed runs ("today − 400 days"), never
absolute calendar dates. Graph projection, candidate generation, screening and risk assessment run inline at
the end of the seed (`GRAPH_WRITER=inline`).

### Firms and members (password for every demo account: **`Kinroot-demo-2025!`**)
**Harbourline Legal (Sydney)** · AU · sector legal · regime AML/CTF Act 2006 (Cth), Tranche 2, commencement 2026-07-01.

| Name | Email | Role |
|---|---|---|
| Olivia Grant (practice manager) | `olivia@harbourline.example` | owner |
| Daniel Cho (AML/CTF compliance officer) | `daniel@harbourline.example` | compliance_officer |
| Margaret Ellis (senior partner) | `margaret@harbourline.example` | partner |
| Tom Nguyen (solicitor) | `tom@harbourline.example` | fee_earner |
| Aisha Karim (conveyancer) | `aisha@harbourline.example` | fee_earner |
| Ruth Adeyemi (independent reviewer) | `ruth@harbourline.example` | auditor |

**Northgate Accountants (London)** · GB · sector accounting · UK MLR 2017; 4 clients; member
`priya@northgate.example` (compliance_officer). Used for UK flows and tenant-isolation tests (no Harbourline user
belongs to it). Its one UK company client is built from the Companies House sample when present
(`data/companies_house/psc_structures.jsonl`), else from a bundled synthetic UK structure.

### Harbourline clients (30)
Keys are stable seed ids used by tests and eval. "Rating" is the expected rules rating; ✱ marks a client whose
challenger is expected to disagree.

| # | Key | Client | Kind | Scenario | Rating |
|---|---|---|---|---|---|
| 1 | `harbour-quay` | Harbour Quay Developments Pty Ltd | company | **Trust over company over offshore holding**: ← 100% Kestrel Ventures Ltd (VG) ← 80% Bellmere Holdings Pty Ltd ← 62% Calder Family Trust (trustee Calder Trustee Co Pty Ltd; appointor Ava Calder) + 38% Ben Okafor. UBOs: Ava Calder 49.6% + control, Ben Okafor 30.4%. Nominee director on Kestrel. | high |
| 2 | `bellmere` | Bellmere Holdings Pty Ltd | company | Mid-layer of #1 onboarded separately (same structure, shorter path) | medium |
| 3 | `calder-trust` | Calder Family Trust | trust | Discretionary trust; corporate trustee; PEP-free; EDD for structure | medium |
| 4 | `tasman-ridge` | Tasman Ridge Pty Ltd | company | **Circular ownership**: Tasman Ridge 60% → Orchard Lane Investments Pty Ltd 70% → Westerly Capital Ltd (NZ) 50% → Tasman Ridge; outside owner Marcus Hale 50% of Tasman Ridge | high ✱ |
| 5 | `orchard-lane` | Orchard Lane Investments Pty Ltd | company | Member of the same cycle | medium |
| 6 | `lumen-trade` | Lumen Trade Pty Ltd | company | **Nominee-director cluster**: director Gregory Pell (address Suite 4, 88 Victoria St, Mahé, SC) who also directs 41 dormant companies; registered office shared | high |
| 7 | `silverbirch` | Silverbirch Imports Pty Ltd | company | Same nominee cluster (Pell + shared address) | high |
| 8 | `coralline` | Coralline Logistics Pty Ltd | company | Same nominee cluster; also shares an accountant's address with #6 | high ✱ |
| 9 | `aurelian-shipping` | Aurelian Shipping Pty Ltd | company | **Sanctions near-match #1** (likely true match): 100% owned by Aurelian Maritime FZE (AE), near-match to `SAMPLE-SAN-0007` "Aurelian Maritime FZCO" (same city, shared director surname) → pending hit; open **case + SMR draft** (access: Daniel full, Margaret summary) | high |
| 10 | `petrov-alexei` | Alexei Petrov | individual | **Sanctions near-match #2** (false positive): name match to `SAMPLE-SAN-0012` "Aleksei Petrov", different birth year and nationality → pending hit; rated medium while the hit is pending | medium |
| 11 | `whitfield-julian` | Hon. Julian Whitfield | individual | **PEP** (fictional NSW Legislative Council member, `SAMPLE-PEP-0003`): confirmed PEP hit; EDD source-of-wealth done; awaiting **senior approval** (Margaret) | high |
| 12 | `whitfield-family` | Whitfield Family Super Fund | trust | SMSF; PEP is member and trustee director → PEP in structure | medium |
| 13 | `ferris-wu` | Ferris & Wu Partners | partnership | Accounting partnership, 3 partners | low |
| 14 | `brightwater-re` | Brightwater Realty Pty Ltd | company | Real-estate agency client; straightforward | low |
| 15 | `nguyen-linh` | Linh Nguyen | individual | Home buyer (conveyancing), electronic verification | low |
| 16 | `oconnor-sean` | Sean O'Connor | individual | Home buyer; **duplicate entry** "Sean OConnor", same DOB → auto-merge | low |
| 17 | `patel-riya` | Riya Patel | individual | Property sale; review overdue by 40 days | low |
| 18 | `harrow-mining` | Harrow Mining Services Pty Ltd | company | 3-layer AU group; one director change in last 90 days → **officer_change alert** | medium |
| 19 | `kestrel-holdings-uk` | Kestrel Holdings (UK) Ltd | company | UK parent with PSC chain (Companies House sample shape); shares officer with Kestrel Ventures (#1) | high |
| 20 | `blue-gum` | Blue Gum Childcare Ltd | company | Company limited by guarantee (charity); no UBO by ownership → senior managing officials | low |
| 21 | `marlowe-art` | Marlowe Fine Art Pty Ltd | company | Art dealer; cash-heavy service flag; review due in 10 days | low |
| 22 | `sato-kenji` | Kenji Sato | individual | Non-resident (JP) buyer, remote channel | medium |
| 23 | `delacroix-trust` | Delacroix Unit Trust | trust | Unit trust: three unit holders 34/33/33 → all UBOs | medium |
| 24 | `northshore-dental` | Northshore Dental Group Pty Ltd | company | Simple 2-owner company | low |
| 25 | `ironbark-ventures` | Ironbark Ventures Pty Ltd | company | **Ownership change** last month: new 40% holder via Cayman entity (KY) → ownership_change alert + risk change | high ✱ |
| 26 | `greenfield-estates` | Greenfield Estates Pty Ltd | company | **Duplicate person** across structures: "Benjamin Okafor" (here) vs "Ben Okafor" (#1), same DOB, different address → review-band candidate | low |
| 27 | `murray-chen` | Murray Chen | individual | Two records "Murray Chen" vs "Murray Cheng", different DOB → reject-band candidate | low |
| 28 | `southbank-holdings` | Southbank Holdings Pty Ltd | company | Unknown owner: 30% held by bearer-style undisclosed holder → `unknown_owner` | high |
| 29 | `lim-family` | Lim Family Trust | trust | Fixed-entitlement beneficiaries; onboarding **incomplete** (missing ID for one beneficiary) | – (onboarding) |
| 30 | `coastal-conveyancing` | Coastal Conveyancing Co | partnership | Low risk; exited client (relationship ended 2 years ago) → appears in retention preview from year 7 | low |

Also seeded: ~120 parties in total; 8 match candidates (2 auto-merged, 4 review, 2 reject); 4 screening hits
(2 sanctions near-matches pending, 1 PEP confirmed, 1 PEP false positive for a namesake of #11); risk
assessments for every active client; 3 disagreements (✱); 6 open alerts (1 list-update hit, 2 ownership/officer
changes, 3 reviews due); 3 overdue and 4 due-soon reviews; 1 internal concern (raised by Tom on #6) and 1 case
(#9) with an SMR draft; training register (one member overdue); a published risk methodology `KR-RM-1.0` and a
draft `KR-RM-1.1`; ≥ 150 audit rows forming a valid chain.

Bundled synthetic list entries (`SAMPLE-SAN-*`, `SAMPLE-PEP-*`) are fictional, clearly labelled, and used
whenever `SANCTIONS_SOURCE=bundled` (default). With `SANCTIONS_SOURCE=opensanctions` the real lists are loaded
**in addition**; seed scenarios still resolve against the sample entries.

---

# Part 6: Project conventions

- **Dates in prose.** Write docs, comments, copy and fixtures in timeless terms, or as of mid-October 2025.
  Australia's Tranche 2 obligations *commence on 1 July 2026*; AUSTRAC enrolment for newly regulated businesses
  opens ahead of commencement. Do not describe later events as having happened.
- **No real run timestamps in committed files.** Eval reports (`eval/RESULTS.md`), model cards, data notes and
  committed artifacts carry versions and metrics, not wall-clock dates. Generated timestamps live only in
  git-ignored outputs (`mlruns/`, `data/`). Strip the "on <date>" from generated Django migration headers.
- **Seed data is relative** to the day the seed runs; never hard-code calendar dates for demo records (except
  fixed statutory dates such as the commencement date).
- **Commit messages** are conventional (`feat:`, `fix:`, `test:`, `docs:`, `chore:`, `ci:`, `refactor:`, `perf:`),
  in logical batches, with no dates and no tool attribution. Stage explicit paths; never commit `data/`, `.venv`,
  `node_modules`, `mlruns/`, `.env` or `*.db`.
- **One heavy process at a time** on small machines: run installs, test suites, servers, training jobs and downloads
  one after another, and stop what you start.
- **Client-facing copy** never shows engineering vocabulary (see the standards' forbidden list); say "second-opinion
  check" or "pattern check" in the UI, "challenger" only in docs.
