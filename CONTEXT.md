# Mission Control

Single-user proactive chief-of-staff engine: a cadence engine that observes (Gmail/GCal/manual capture), reconciles what it sees against the Commitment Ledger, and drafts artifacts for the owner's approval — on a schedule, whether or not the app is opened.

## Language

**Brief**:
A generated artifact delivered to the owner — morning, EOD close, weekly review, or prep brief. Content never changes after generation.
_Avoid_: packet, report

**Prep Brief**:
The brief generated ~45 minutes before a flagged meeting, carrying counterparty and commitment context.
_Avoid_: prep packet, meeting packet

**ContextPacket**:
The persisted, assembled input handed to a generation task; every brief traces back to exactly one.
_Avoid_: bare "packet" for anything else

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
