# Insights Log

Product learnings, one dated entry each. Graduation-gate metric 5 counts these (target ≥50).

- **2026-06-09 · Plan-grilling session (pre-code).** Walked all six planning docs against each other before Phase 0; 12 contradictions/gaps resolved and propagated. The ones that were *product* learnings, not just spec fixes:
- **2026-06-09 · Queue noise shapes every ingest decision.** First-connect backfill ingests 30 days of episodes but deliberately extracts nothing from them — R3 (queue noise kills the habit) outweighs day-1 ledger seeding. In-flight commitments enter manually.
- **2026-06-09 · Snooze is a predicate, not a state.** Any status that needs a system waker violates "state advances only by user disposition." Encoding snooze as `snoozed_until` + WHERE clauses removed a job, a status value, and an invariant exception at once. Pattern worth reusing: prefer time-predicates over states that require schedulers.
- **2026-06-09 · Artifacts must pre-sync.** Every brief fires outside the ingest window (7 AM, Sunday 7 PM); without an inline pre-sync step the Monday brief renders Friday's calendar. "Proactive" means fresh-at-generation, not fresh-at-last-poll.
- **2026-06-09 · R2 decided: consumer Gmail + Testing-status OAuth app.** Multiple Gmail accounts are an expected growth path, so the per-mailbox Workspace escape doesn't scale. Weekly token expiry is now a designed-for ritual (one-tap re-consent + push alert in MC-101), not a risk.
- **2026-06-09 · Chat is capture first, retrieval later.** v1 chat = capture surface with inline candidates (Phase 1); ask-the-ledger waits until the substrate it queries exists (Phase 4). Matches the thesis: chat is bolted on.
- **2026-06-09 · Eval truth lives in git, not the DB.** Committed results files per prompt version; `prompt_versions` rows written only at activation. Keeps prod credentials out of CI and dev eval spend out of the R5 cost ticker.
