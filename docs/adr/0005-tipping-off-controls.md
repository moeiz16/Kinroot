# ADR 0005: Tipping-off controls: need-to-know cases and non-revealing responses

**Status:** accepted

## Context
Under the AML/CTF Act 2006 (Cth) s123 and POCA 2002 s333A (UK), disclosing that a suspicious-matter report has
been or may be made is an offence. Staff who deal with the client (fee earners, sometimes partners) must not learn
of a case through the product: not through a badge, a count, an error message, an audit row, an event or an
assistant answer.

## Decision
- **Need-to-know access**: case content requires `smr:read` (compliance officer) **and** an entry on the case's
  access list (`full` or `summary`). No other role reads cases, including the firm administrator.
- **404, never 403**, for cases a user may not see, so existence is not disclosed.
- **No side channels**: case counts, case events (`case.updated`), restricted audit rows and case-driven alerts are
  filtered out for users without access. Client records never show case flags. The assistant has no tool that
  reads cases.
- **Neutral holds**: while a case is open, actions that could alert the client (information requests, exit
  notices, closing the matter) return `409 action_held` with the same wording used for every other hold
  ("This step needs the compliance officer's go-ahead").
- **Concerns are one-way**: any staff member can raise a concern; they see only "received", never the outcome.
- **Summary access** lets a partner support a case without reading the grounds: the API nulls restricted fields
  and lists them in `redactedFields`, and the UI shows redaction bars only to users who already know the case exists.
- Every case action is audited as a restricted row that stays in the org's hash chain.

## Consequences
- Tests assert the absence of leaks for each role: case list, client detail, dashboard counts, SSE stream, audit
  list, assistant answers and error bodies.
- Some legitimate workflow friction (holds) is accepted; the compliance officer can release a hold with a note.
