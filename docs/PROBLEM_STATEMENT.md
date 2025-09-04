# Problem statement

## Who has the problem
Australia's AML/CTF Amendment Act 2024 extends the AML/CTF regime to "tranche 2" professions: lawyers,
accountants, conveyancers, real-estate agents, trust and company service providers and dealers in precious
stones and metals. Their obligations **commence on 1 July 2026**. From then a small or mid-size law firm must
enrol with AUSTRAC (enrolment opens ahead of commencement), appoint an AML/CTF compliance officer, run an AML/CTF
program, carry out customer due diligence before providing a designated service, identify beneficial owners, keep
records for 7 years and report suspicious matters without tipping off the client.

UK firms in the same professions have done this under the Money Laundering Regulations 2017 for years, and still
struggle with the same core task.

Most of these firms have never done this work. Their clients are often not people but **structures**: a family
trust whose corporate trustee owns a property company, which is in turn held through an overseas holding company.
"Who really owns or controls this client?" is a graph question, and the firm has to answer it, show its
working, and re-check it when anything changes.

## What goes wrong today
- **Beneficial owners are missed** because ownership is traced by hand through PDFs and registry extracts; effective
  percentages through several layers are multiplied wrongly or not at all; circular holdings are not noticed.
- **The same person appears many times** with spelling variants across clients and registries, hiding that one
  individual (or one nominee director) sits behind several clients.
- **Screening is noisy**: common names produce near-matches that take time to clear, and the reasons for clearing
  them are not recorded.
- **Risk ratings are not explainable** or not consistent between fee earners, and nobody checks the methodology
  against outcomes.
- **Ongoing monitoring is calendar-only**: changes in ownership or new list entries are found at the next periodic
  review, if at all.
- **Tipping-off risk**: suspicion is discussed in email threads visible to the people who deal with the client.

## What Kinroot does
1. Onboards individuals, companies, trusts and partnerships with an identity checklist, consent capture and
   mocked electronic verification.
2. Builds the **ownership and control graph** from forms and registry data, computes ultimate beneficial owners
   (≥ 25% or control) at any date, and explains every path in a sentence.
3. Resolves duplicate people and companies with an explainable matcher and a human merge/split queue.
4. Screens everyone in the structure against sanctions and PEP lists and records each review decision with a reason.
5. Rates risk with a versioned, regulator-readable methodology, triggers enhanced due diligence, and routes
   sign-off to the compliance officer and a partner; a second-opinion model flags ratings worth a second look.
6. Monitors continuously: list updates, structure changes, review due dates.
7. Manages concerns, cases and suspicious-matter report drafts behind need-to-know access.
8. Answers investigation questions ("how is this person connected to that company?") by walking the graph and
   citing every relationship it used.

## Success measures
- UBO computation correct on every crafted structure, including cycles and trusts (unit-tested).
- Entity resolution: matcher F1 above the Fellegi-Sunter baseline, ≥ 0.99 precision for automatic merges, and a
  review queue small enough for one compliance officer.
- Screening precision on the labelled near-match set; time to clear a false positive.
- Risk: challenger AUC and calibration, agreement rate with the rules, stability of scores under irrelevant changes.
- Program health on the dashboard: overdue reviews, screening backlog, sign-offs waiting.

## Out of scope
Transaction monitoring for financial institutions, live government identity verification (mocked), lodging real
reports with AUSTRAC or the NCA (a mock submission reference is produced), and legal advice. Kinroot is designed to
support a firm's AML/CTF program; it does not make a firm compliant on its own and claims no certification.
