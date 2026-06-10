import { describe, expect, it, vi } from "vitest";
import type { ExtractedCommitmentT } from "@mission-control/core";
import { contentWords, jaccard, matchFixture, type Judge } from "./match";
import type { ExpectedCommitmentT } from "./fixtures";

const neverJudge: Judge = async () => {
  throw new Error("judge must not be called for this case");
};

function pred(over: Partial<ExtractedCommitmentT>): ExtractedCommitmentT {
  return {
    direction: "owed_to_me",
    counterparty_name: "Dana",
    counterparty_email: "dana@acme-co.example",
    description: "send revised deck",
    due_date: "2026-05-14",
    due_date_basis: "explicit",
    confidence: 0.9,
    source_excerpt: "I'll get you the revised deck by Thursday.",
    ...over,
  };
}

function exp(over: Partial<ExpectedCommitmentT>): ExpectedCommitmentT {
  return {
    direction: "owed_to_me",
    counterparty: "dana@acme-co.example",
    description_gist: "send revised deck",
    due: { date: "2026-05-14", basis: "explicit" },
    ...over,
  };
}

describe("contentWords / jaccard", () => {
  it("drops stopwords and short tokens", () => {
    expect(contentWords("send the revised deck to me")).toEqual(["revised", "deck"]);
  });
  it("identical gists score 1", () => {
    expect(jaccard("send revised deck", "send revised deck")).toBe(1);
  });
  it("disjoint gists score 0", () => {
    expect(jaccard("wire deposit", "review draft comments")).toBe(0);
  });
});

describe("matchFixture gates", () => {
  it("matches the exact pair", async () => {
    const r = await matchFixture([exp({})], [pred({})], { judge: neverJudge });
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0]).toMatchObject({ dueDateOk: true, basisSoftMiss: false });
    expect(r.falsePositives).toHaveLength(0);
    expect(r.falseNegatives).toHaveLength(0);
  });

  it("direction mismatch is a hard fail", async () => {
    const r = await matchFixture([exp({})], [pred({ direction: "owed_by_me" })], { judge: neverJudge });
    expect(r.matches).toHaveLength(0);
    expect(r.falsePositives).toEqual([0]);
    expect(r.falseNegatives).toEqual([0]);
  });

  it("counterparty matches via the alias table", async () => {
    const r = await matchFixture(
      [exp({})],
      [pred({ counterparty_email: null, counterparty_name: "Dana Reyes" })],
      { aliases: { "dana@acme-co.example": ["Dana Reyes"] }, judge: neverJudge },
    );
    expect(r.matches).toHaveLength(1);
  });

  it("due-date disagreement is a hard fail; basis disagreement is a soft miss", async () => {
    const wrongDate = await matchFixture([exp({})], [pred({ due_date: "2026-05-15" })], { judge: neverJudge });
    expect(wrongDate.matches).toHaveLength(0);

    const wrongBasis = await matchFixture([exp({})], [pred({ due_date_basis: "inferred" })], { judge: neverJudge });
    expect(wrongBasis.matches).toHaveLength(1);
    expect(wrongBasis.matches[0]!.basisSoftMiss).toBe(true);
  });

  it("both-null due dates agree", async () => {
    const r = await matchFixture(
      [exp({ due: null })],
      [pred({ due_date: null, due_date_basis: null })],
      { judge: neverJudge },
    );
    expect(r.matches).toHaveLength(1);
  });

  it("ambiguous-band descriptions go to the judge", async () => {
    const judge = vi.fn(async () => true);
    // "deliver the updated slide deck" vs "send revised deck": only "deck"
    // overlaps → jaccard in (0.2, 0.5)
    const r = await matchFixture(
      [exp({})],
      [pred({ description: "deliver updated deck" })],
      { judge },
    );
    expect(judge).toHaveBeenCalledTimes(1);
    expect(r.matches).toHaveLength(1);

    const judgeNo = vi.fn(async () => false);
    const r2 = await matchFixture([exp({})], [pred({ description: "deliver updated deck" })], { judge: judgeNo });
    expect(r2.matches).toHaveLength(0);
  });

  it("below-band descriptions fail without consulting the judge", async () => {
    const judge = vi.fn(async () => true);
    const r = await matchFixture([exp({})], [pred({ description: "wire transfer money" })], { judge });
    expect(judge).not.toHaveBeenCalled();
    expect(r.matches).toHaveLength(0);
  });

  it("greedy one-to-one: each expected matches at most one prediction", async () => {
    const e = [exp({}), exp({ description_gist: "intro Dana to Priya", direction: "owed_by_me", due: { date: "2026-05-14", basis: "inferred" } })];
    const p = [
      pred({}),
      pred({ description: "send revised deck again" }), // duplicate-ish prediction
    ];
    const r = await matchFixture(e, p, { judge: async () => false });
    expect(r.matches).toHaveLength(1); // best pair wins
    expect(r.falsePositives).toHaveLength(1); // the duplicate counts against precision
    expect(r.falseNegatives).toHaveLength(1); // the intro was never predicted
  });
});
