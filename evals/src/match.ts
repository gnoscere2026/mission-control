import type { ExtractedCommitmentT } from "@mission-control/core";
import type { ExpectedCommitmentT } from "./fixtures";

// EVAL-SPEC §2: deterministic matching first, LLM judge only for the fuzzy
// middle band. Greedy one-to-one assignment, best overlap first.

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "will", "would",
  "you", "your", "their", "them", "they", "our", "out", "get", "send",
]);

export function contentWords(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

export function jaccard(a: string, b: string): number {
  const wa = new Set(contentWords(a));
  const wb = new Set(contentWords(b));
  if (wa.size === 0 && wb.size === 0) return 1;
  if (wa.size === 0 || wb.size === 0) return 0;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  return inter / (wa.size + wb.size - inter);
}

export type Judge = (predDescription: string, goldGist: string) => Promise<boolean>;

export interface MatchPair {
  expIdx: number;
  predIdx: number;
  dueDateOk: boolean;
  basisSoftMiss: boolean;
}

export interface MatchResult {
  matches: MatchPair[];
  falsePositives: number[]; // predicted indexes with no expected partner
  falseNegatives: number[]; // expected indexes with no predicted partner
}

function counterpartyMatches(
  pred: ExtractedCommitmentT,
  exp: ExpectedCommitmentT,
  aliases: Record<string, string[]> = {},
): boolean {
  const expected = exp.counterparty.toLowerCase();
  const predEmail = pred.counterparty_email?.toLowerCase();
  const predName = pred.counterparty_name?.toLowerCase();
  if (predEmail && predEmail === expected) return true;
  if (predName && predName === expected) return true;
  const aliasList = (aliases[exp.counterparty] ?? []).map((a) => a.toLowerCase());
  if (predName && aliasList.includes(predName)) return true;
  if (predEmail && aliasList.includes(predEmail)) return true;
  return false;
}

function dueAgreement(
  pred: ExtractedCommitmentT,
  exp: ExpectedCommitmentT,
): { ok: boolean; basisSoftMiss: boolean } {
  if (exp.due === null && pred.due_date === null) return { ok: true, basisSoftMiss: false };
  if (exp.due === null || pred.due_date === null) return { ok: false, basisSoftMiss: false };
  if (exp.due.date !== pred.due_date) return { ok: false, basisSoftMiss: false };
  // basis disagreement is a soft miss — informative, not load-bearing (§2.3)
  return { ok: true, basisSoftMiss: pred.due_date_basis !== exp.due.basis };
}

export async function matchFixture(
  expected: ExpectedCommitmentT[],
  predicted: ExtractedCommitmentT[],
  opts: { aliases?: Record<string, string[]>; judge: Judge },
): Promise<MatchResult> {
  // score every viable pair (direction + counterparty + due gates), then the
  // description test, hardest filter last
  const pairs: { expIdx: number; predIdx: number; j: number }[] = [];
  for (let e = 0; e < expected.length; e++) {
    for (let p = 0; p < predicted.length; p++) {
      const exp = expected[e]!;
      const pred = predicted[p]!;
      if (pred.direction !== exp.direction) continue;
      if (!counterpartyMatches(pred, exp, opts.aliases)) continue;
      if (!dueAgreement(pred, exp).ok) continue;
      pairs.push({ expIdx: e, predIdx: p, j: jaccard(pred.description, exp.description_gist) });
    }
  }
  pairs.sort((a, b) => b.j - a.j);

  const usedExp = new Set<number>();
  const usedPred = new Set<number>();
  const matches: MatchPair[] = [];

  for (const pair of pairs) {
    if (usedExp.has(pair.expIdx) || usedPred.has(pair.predIdx)) continue;
    const exp = expected[pair.expIdx]!;
    const pred = predicted[pair.predIdx]!;

    let descriptionOk = pair.j >= 0.5;
    if (!descriptionOk && pair.j >= 0.2) {
      descriptionOk = await opts.judge(pred.description, exp.description_gist);
    }
    if (!descriptionOk) continue;

    usedExp.add(pair.expIdx);
    usedPred.add(pair.predIdx);
    const due = dueAgreement(pred, exp);
    matches.push({
      expIdx: pair.expIdx,
      predIdx: pair.predIdx,
      dueDateOk: due.ok,
      basisSoftMiss: due.basisSoftMiss,
    });
  }

  return {
    matches,
    falsePositives: predicted.map((_, i) => i).filter((i) => !usedPred.has(i)),
    falseNegatives: expected.map((_, i) => i).filter((i) => !usedExp.has(i)),
  };
}
