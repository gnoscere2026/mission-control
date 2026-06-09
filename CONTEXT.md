# Mission Control

Single-user proactive chief-of-staff engine: a cadence engine that observes (Gmail/GCal/manual capture), reconciles what it sees against the Commitment Ledger, and drafts artifacts for the owner's approval — on a schedule, whether or not the app is opened.

## Language

**Candidate**:
A commitment as extraction produced it, awaiting the owner's first disposition; not yet part of the ledger.

**Proposal**:
A pending, evidence-backed suggestion from reconciliation that an existing open commitment changed state (done, slipped, contradicted). A Candidate creates; a Proposal amends.
_Avoid_: suggestion, flag

**Snooze**:
A user-set wake time that hides a commitment from every surface until it passes; the commitment's status is unchanged throughout.
_Avoid_: snoozed as a status or state

**Append-only**:
A record stream where nothing is ever deleted and content is never rewritten; a record's named lifecycle state (a run closing, a brief being opened or delivered) may be set exactly once.
_Avoid_: immutable (reserve for content that never changes at all)
