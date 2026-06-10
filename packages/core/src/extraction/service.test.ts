import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  commitments,
  createDb,
  episodes,
  people,
  users,
  type Db,
} from "@mission-control/db";
import type { complete } from "@mission-control/llm";
import { extractCommitmentsFromEpisode, extractionHash, normalizeDescription } from "./service";
import type { ExtractionOutputT } from "./extract_commitments.v1";

const url =
  process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5433/mission_control";

const OWNER_EMAIL = "extraction-svc-test@example.com";
let db: Db;
let ownerId: string;

beforeAll(async () => {
  ({ db } = createDb(url));
  await db
    .insert(users)
    .values({ email: OWNER_EMAIL, displayName: "Extraction Test" })
    .onConflictDoNothing();
  const [u] = await db.select().from(users).where(eq(users.email, OWNER_EMAIL));
  ownerId = u!.id;
});

beforeEach(async () => {
  await db.delete(commitments).where(eq(commitments.ownerId, ownerId));
  await db.delete(episodes).where(eq(episodes.ownerId, ownerId));
  await db.delete(people).where(eq(people.ownerId, ownerId));
});

async function seedEmailEpisode(): Promise<string> {
  const [ep] = await db
    .insert(episodes)
    .values({
      ownerId,
      occurredAt: new Date("2026-06-08T14:00:00Z"),
      type: "email_received",
      source: "gmail",
      summary: "Re: Q3 readout",
      rawRef: `msg-${crypto.randomUUID()}`,
      payload: {
        from: "Dana Reyes <dana@acme.example>",
        to: `Mark <${OWNER_EMAIL}>`,
        subject: "Re: Q3 readout",
        bodyExcerpt: "I'll get you the revised deck by Thursday.",
      },
    })
    .returning({ id: episodes.id });
  return ep!.id;
}

function fakeComplete(output: ExtractionOutputT) {
  return vi.fn(async () => ({
    data: output,
    modelCallId: crypto.randomUUID(),
    costUsd: "0.001000",
    latencyMs: 5,
  })) as unknown as typeof complete & ReturnType<typeof vi.fn>;
}

const deckOutput: ExtractionOutputT = {
  commitments: [
    {
      direction: "owed_to_me",
      counterparty_name: "Dana Reyes",
      counterparty_email: "dana@acme.example",
      description: "send revised deck",
      due_date: "2026-06-11",
      due_date_basis: "explicit",
      confidence: 0.95,
      source_excerpt: "I'll get you the revised deck by Thursday.",
    },
  ],
};

describe("normalizeDescription / extractionHash", () => {
  it("normalizes case, punctuation, whitespace", () => {
    expect(normalizeDescription("  Send the   Revised DECK!! ")).toBe("send the revised deck");
  });
  it("hash is stable across wording-irrelevant changes", () => {
    expect(extractionHash("ref1", "Send the deck!")).toBe(extractionHash("ref1", "send the DECK"));
    expect(extractionHash("ref1", "send deck")).not.toBe(extractionHash("ref2", "send deck"));
  });
});

describe("extractCommitmentsFromEpisode", () => {
  it("writes a candidate with all fields and resolves the counterparty person", async () => {
    const episodeId = await seedEmailEpisode();
    const impl = fakeComplete(deckOutput);
    const result = await extractCommitmentsFromEpisode(db, {
      ownerId,
      episodeId,
      completeImpl: impl,
    });
    expect(result).toEqual({ status: "done", created: 1, duplicates: 0 });

    const [row] = await db.select().from(commitments).where(eq(commitments.ownerId, ownerId));
    expect(row).toMatchObject({
      direction: "owed_to_me",
      description: "send revised deck",
      sourceType: "email",
      sourceEpisodeId: episodeId,
      status: "candidate",
      dueDate: "2026-06-11",
      dueDateBasis: "explicit",
      promptVersion: "v1",
    });
    expect(row!.confidence).toBeCloseTo(0.95);
    expect(row!.extractionHash).toBeTruthy();

    const [person] = await db.select().from(people).where(eq(people.id, row!.counterpartyPersonId!));
    expect(person!.displayName).toBe("Dana Reyes");
  });

  it("is idempotent on extraction_hash: re-running with force creates no duplicate", async () => {
    const episodeId = await seedEmailEpisode();
    await extractCommitmentsFromEpisode(db, { ownerId, episodeId, completeImpl: fakeComplete(deckOutput) });
    const second = await extractCommitmentsFromEpisode(db, {
      ownerId,
      episodeId,
      force: true,
      completeImpl: fakeComplete(deckOutput),
    });
    expect(second).toEqual({ status: "done", created: 0, duplicates: 1 });
    const rows = await db.select().from(commitments).where(eq(commitments.ownerId, ownerId));
    expect(rows).toHaveLength(1);
  });

  it("episode guard: a second run makes ZERO model calls and creates nothing", async () => {
    const episodeId = await seedEmailEpisode();
    await extractCommitmentsFromEpisode(db, { ownerId, episodeId, completeImpl: fakeComplete(deckOutput) });

    // a v2-style rewording would produce a different hash — the guard must
    // prevent even reaching the model
    const reworded = fakeComplete({
      commitments: [
        { ...deckOutput.commitments[0]!, description: "deliver the updated slide deck" },
      ],
    });
    const result = await extractCommitmentsFromEpisode(db, {
      ownerId,
      episodeId,
      completeImpl: reworded,
    });
    expect(result.status).toBe("skipped_existing");
    expect(reworded).not.toHaveBeenCalled();
    expect(await db.select().from(commitments).where(eq(commitments.ownerId, ownerId))).toHaveLength(1);
  });

  it("chat episode: maps sourceType chat and resolves a name-only counterparty", async () => {
    const [ep] = await db
      .insert(episodes)
      .values({
        ownerId,
        occurredAt: new Date("2026-06-08T16:00:00Z"),
        type: "chat_message",
        source: "chat",
        summary: "told Sara I'd send the contract Friday",
        payload: { text: "told Sara I'd send the contract Friday" },
      })
      .returning({ id: episodes.id });

    const impl = fakeComplete({
      commitments: [
        {
          direction: "owed_by_me",
          counterparty_name: "Sara",
          counterparty_email: null,
          description: "send Sara the contract",
          due_date: "2026-06-12",
          due_date_basis: "explicit",
          confidence: 0.9,
          source_excerpt: "told Sara I'd send the contract Friday",
        },
      ],
    });
    await extractCommitmentsFromEpisode(db, { ownerId, episodeId: ep!.id, completeImpl: impl });

    const [row] = await db.select().from(commitments).where(eq(commitments.ownerId, ownerId));
    expect(row!.sourceType).toBe("chat");
    expect(row!.direction).toBe("owed_by_me");
    const [person] = await db.select().from(people).where(eq(people.id, row!.counterpartyPersonId!));
    expect(person!.displayName).toBe("Sara");
    expect(person!.emails).toEqual([]);
  });

  it("empty extraction output writes nothing and still succeeds", async () => {
    const episodeId = await seedEmailEpisode();
    const result = await extractCommitmentsFromEpisode(db, {
      ownerId,
      episodeId,
      completeImpl: fakeComplete({ commitments: [] }),
    });
    expect(result).toEqual({ status: "done", created: 0, duplicates: 0 });
    expect(await db.select().from(commitments).where(eq(commitments.ownerId, ownerId))).toHaveLength(0);
  });
});
