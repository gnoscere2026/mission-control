# Mission Control — Commitment-Extraction Eval Harness Spec (v1)

**Deliverable §9.7** · implements brief §5 ("eval harness from week one"). Built in MC-106; lives in `evals/`.

Purpose: make extraction precision/recall **visible and movable** per prompt version, and make prompt changes **gated** on measured results — so quality is a number that improves, not a feeling.

---

## 1. Fixtures

### 1.1 Shape

One JSON file per fixture in `evals/fixtures/extraction/`, named `fx-<seq>-<slug>.json`:

```jsonc
{
  "id": "fx-014-deck-promise",
  "source_type": "email",                 // email | calendar | manual | chat
  "input": {
    "from": "dana@acme-co.example",
    "to": "mark@example.com",
    "subject": "Re: Q3 readout",
    "occurred_at": "2026-05-12T16:04:00-06:00",
    "body": "Sounds good. I'll get you the revised deck by Thursday. Can you intro me to Priya before then?"
  },
  "expected": [
    {
      "direction": "owed_to_me",
      "counterparty": "dana@acme-co.example",
      "description_gist": "send revised deck",
      "due": { "date": "2026-05-14", "basis": "explicit" }   // null when none
    },
    {
      "direction": "owed_by_me",
      "counterparty": "dana@acme-co.example",
      "description_gist": "intro Dana to Priya",
      "due": { "date": "2026-05-14", "basis": "inferred" }
    }
  ],
  "notes": "two commitments in one message, opposite directions; 'by Thursday' resolves from occurred_at",
  "anonymized": true                       // runner refuses fixtures where false
}
```

Hard negatives are fixtures with `"expected": []` — newsletters, FYI threads, pleasantries ("we should grab coffee sometime" — aspirational, not a commitment), scheduling chatter already captured by calendar. **Target mix: ≥⅓ hard negatives.** Precision dies on these, so the set must be rich in them.

### 1.2 Sourcing and anonymization (blocking workflow)

Fixtures come from Mark's real email — that's the point — but the repo never contains real content:

1. Export candidate message → `evals/fixtures/_staging/` (git-ignored).
2. Run `npm run eval:anonymize -- <file>`: substitutes names/emails/orgs from a deterministic fake pool (so "Dana" is consistently "Dana" within a fixture), shifts dates by a random per-fixture offset (preserving weekday and relative gaps — due-date inference depends on them), strips signatures/quoted history not needed for the case.
3. **Human pass** — read the output, confirm nothing identifying survived, set `"anonymized": true`, move into `fixtures/extraction/`.
4. Runner hard-fails on any fixture with `anonymized != true`; CI runs gitleaks-style scanning on `evals/` (see RISK-REGISTER R7).

### 1.3 Growth policy

Start ≥25 (MC-106). Every production **rejection** or **edit** in the confirmation queue is a fixture candidate: a weekly prompt (`/queue` shows "promote to fixture?") exports the episode through the same staging→anonymize→review pipeline. Target ≥100 fixtures by end of Phase 2. Fixtures are append-only; a fixture that turns out to be mislabeled gets corrected in place with a note, never silently deleted.

## 2. Matching: when does a predicted commitment count?

Deterministic first, judge only for the fuzzy middle:

A predicted commitment **matches** an expected one when **all** of:
1. `direction` equal (hard requirement);
2. counterparty resolves to the same fixture identity (email match or fixture alias table);
3. due-date agreement: both null, or dates equal; `basis` disagreement is a **soft miss** (counted separately, not a failed match — basis is informative, not load-bearing);
4. description match: normalized token-overlap (Jaccard ≥ 0.5 on content words) **or**, when overlap is in the ambiguous 0.2–0.5 band, a cheap-tier LLM judge ("do these describe the same obligation? yes/no") — judge calls go through `packages/llm` (cost-tracked, `task: eval.match_judge`), and verdicts are **cached** in `evals/.judge-cache.json` keyed by hash(pred, gold) so reruns are deterministic and free.

Greedy one-to-one assignment (each expected matches at most one prediction, best-overlap first). Leftover predictions = false positives; leftover expected = false negatives.

## 3. Metrics

Per run (task + prompt version + fixture set hash):

- **Precision** = matches / predictions — *the* number for v1 (a noisy queue kills the habit; a missed commitment is recoverable, a spammy queue is not).
- **Recall** = matches / expected, and **F1** for trend lines.
- **Hard-negative precision** — predictions on `expected: []` fixtures (reported separately; the most diagnostic slice).
- **Due-date accuracy** among matched pairs (incl. basis soft-misses).
- **Cost + latency** per fixture (from `model_calls`) — a prompt that doubles cost for +1 pt needs a conversation.

Output: console table + a **committed** results file per (task, version): `evals/results/<task>/<version>.json` — precision, recall, F1, hard-negative precision, due-date accuracy, fixture-set hash, prompt `content_hash`, cost/latency. **The repo is the source of truth for eval history.** The `prompt_versions` row is written at *activation* time from this file (§5.3), never by the runner — so the gate works from a fresh clone and CI needs no production access. Eval-run `model_calls` rows land in the local/CI throwaway DB the runner points at, never production: the R5 daily-cost ticker stays a pure product number.

Production shadow metric (not the harness, but the same definition): rolling 7-day confirm-rate from `extraction_labels` (`confirmed + edited` / total). Divergence between harness precision and production confirm-rate means the fixture set has drifted from reality → grow fixtures (§1.3).

## 4. Runner

```
npm run eval -- --task cos.extract_commitments [--version v3] [--against active] [--fixtures <glob>]
```

- Loads the prompt module + Zod schema for the named version from `packages/core/extraction/`.
- Runs every fixture through the real `packages/llm.complete()` path (same forced tool-use, same schema-retry) against the **cheap tier** — the harness must measure the production configuration, never a different model.
- Requires a `DATABASE_URL` for the `model_calls` write path — local docker or the CI throwaway Postgres; the runner refuses a production URL.
- `--against active` prints a side-by-side delta vs. the active version's committed results file.
- Deterministic given the judge cache; a cold-cache run on ~100 fixtures costs cents (Haiku).

## 5. Gating workflow

1. Any PR touching `packages/core/extraction/**` (prompt, schema, or post-processing) **must** include an eval run: the PR commits `evals/results/<task>/<version>.json`, and the CI job re-runs the harness against a throwaway Postgres (provider key in CI secrets) and fails if no results file was committed, the file's `content_hash` doesn't match the prompt module, or the re-run materially disagrees with the committed numbers (the judge cache makes reruns deterministic).
2. **Gate rule:** new version activates only if precision ≥ active-version precision − 1 pt **and** hard-negative precision does not regress — both read from the committed results files. Recall may be traded down consciously — the PR must say so. Override allowed with an explicit justification line in the PR **and** an INSIGHTS.md entry (overrides are product learning by definition).
3. Activation = updating the single active-version config reference (CLAUDE.md conventions); the release step then writes the `prompt_versions` row *from the committed results file* and sets `activated_at`. `commitments.prompt_version` and `extraction_labels.prompt_version` then attribute all production signal to it.
4. **Auto-accept is earned, not assumed (brief §5):** the confidence threshold gate unlocks only when, over ≥100 production labels on the active version, precision within the `confidence ≥ X` bucket is ≥ 0.95. The harness ships the bucket report (`--report confidence-buckets`) from day one so the unlock date is a measurement, not a debate. Until then, everything stays human-confirmed.

## 6. Trajectory expectations

Week-2 numbers may be mediocre (the brief says so; prior art plateaued ~70% retrieval precision on a different problem). The harness exists so the trajectory is visible: record the baseline in `prompt_versions` at MC-106, re-run on every prompt change, and review the trend at each phase boundary alongside the risk register (R3's triggers reference these numbers).
