import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { desc, eq } from "drizzle-orm";
import {
  commitments,
  createDb,
  episodes,
  extractionLabels,
  userActions,
  users,
  type Db,
} from "@mission-control/db";
import {
  addManualCommitment,
  confirmCommitment,
  editAndConfirmCommitment,
  rejectCommitment,
  snoozeCommitment,
} from "./dispositions";
import { listCandidates, listLedger } from "./queries";

const url =
  process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5433/mission_control";

const OWNER_EMAIL = "dispositions-test@example.com";
const OTHER_EMAIL = "dispositions-other@example.com";
let db: Db;
let ownerId: string;
let otherId: string;

beforeAll(async () => {
  ({ db } = createDb(url));
  for (const email of [OWNER_EMAIL, OTHER_EMAIL]) {
    await db.insert(users).values({ email, displayName: "Disp Test" }).onConflictDoNothing();
  }
  const [u] = await db.select().from(users).where(eq(users.email, OWNER_EMAIL));
  ownerId = u!.id;
  const [o] = await db.select().from(users).where(eq(users.email, OTHER_EMAIL));
  otherId = o!.id;
});

beforeEach(async () => {
  for (const oid of [ownerId, otherId]) {
    await db.delete(extractionLabels).where(eq(extractionLabels.ownerId, oid));
    await db.delete(userActions).where(eq(userActions.ownerId, oid));
    await db.delete(commitments).where(eq(commitments.ownerId, oid));
    await db.delete(episodes).where(eq(episodes.ownerId, oid));
  }
});

async function seedCandidate(oid = ownerId): Promise<string> {
  const [ep] = await db
    .insert(episodes)
    .values({
      ownerId: oid,
      occurredAt: new Date(),
      type: "email_received",
      source: "gmail",
      summary: "seed",
      rawRef: `seed-${crypto.randomUUID()}`,
    })
    .returning({ id: episodes.id });
  const [c] = await db
    .insert(commitments)
    .values({
      ownerId: oid,
      direction: "owed_to_me",
      description: "send revised deck",
      sourceType: "email",
      sourceEpisodeId: ep!.id,
      status: "candidate",
      confidence: 0.9,
      promptVersion: "v1",
    })
    .returning({ id: commitments.id });
  return c!.id;
}

async function getCommitment(id: string) {
  const [row] = await db.select().from(commitments).where(eq(commitments.id, id));
  return row!;
}

async function latestAction(oid = ownerId) {
  const [row] = await db
    .select()
    .from(userActions)
    .where(eq(userActions.ownerId, oid))
    .orderBy(desc(userActions.createdAt))
    .limit(1);
  return row;
}

describe("confirmCommitment", () => {
  it("candidate→open with confirmed_at, user_action + confirmed label", async () => {
    const id = await seedCandidate();
    await confirmCommitment(db, { ownerId, commitmentId: id });

    const row = await getCommitment(id);
    expect(row.status).toBe("open");
    expect(row.confirmedAt).not.toBeNull();

    const action = await latestAction();
    expect(action).toMatchObject({ action: "commitment_confirmed", entityId: id });

    const [label] = await db.select().from(extractionLabels).where(eq(extractionLabels.ownerId, ownerId));
    expect(label).toMatchObject({ commitmentId: id, label: "confirmed", promptVersion: "v1" });
  });

  it("is a no-op on an already-open commitment (no duplicate label)", async () => {
    const id = await seedCandidate();
    await confirmCommitment(db, { ownerId, commitmentId: id });
    await expect(confirmCommitment(db, { ownerId, commitmentId: id })).rejects.toThrow(/not a candidate/);
    const labels = await db.select().from(extractionLabels).where(eq(extractionLabels.ownerId, ownerId));
    expect(labels).toHaveLength(1);
  });

  it("cannot disposition another owner's commitment", async () => {
    const id = await seedCandidate(otherId);
    await expect(confirmCommitment(db, { ownerId, commitmentId: id })).rejects.toThrow(/not found|not a candidate/);
  });
});

describe("rejectCommitment", () => {
  it("candidate→dropped with resolved_at + rejected label", async () => {
    const id = await seedCandidate();
    await rejectCommitment(db, { ownerId, commitmentId: id });
    const row = await getCommitment(id);
    expect(row.status).toBe("dropped");
    expect(row.resolvedAt).not.toBeNull();
    const [label] = await db.select().from(extractionLabels).where(eq(extractionLabels.ownerId, ownerId));
    expect(label!.label).toBe("rejected");
  });
});

describe("editAndConfirmCommitment", () => {
  it("applies edits, confirms, and records the field diff", async () => {
    const id = await seedCandidate();
    await editAndConfirmCommitment(db, {
      ownerId,
      commitmentId: id,
      edits: { description: "send the FINAL deck", dueDate: "2026-06-15", direction: "owed_by_me" },
    });

    const row = await getCommitment(id);
    expect(row.status).toBe("open");
    expect(row.description).toBe("send the FINAL deck");
    expect(row.dueDate).toBe("2026-06-15");
    expect(row.direction).toBe("owed_by_me");

    const [label] = await db.select().from(extractionLabels).where(eq(extractionLabels.ownerId, ownerId));
    expect(label!.label).toBe("edited");
    const diff = label!.editedFields as Record<string, { from: unknown; to: unknown }>;
    expect(diff.description).toEqual({ from: "send revised deck", to: "send the FINAL deck" });
    expect(diff.direction).toEqual({ from: "owed_to_me", to: "owed_by_me" });
  });
});

describe("snoozeCommitment", () => {
  it("sets snoozed_until only — status unchanged, NO label (snooze is a predicate)", async () => {
    const id = await seedCandidate();
    const until = new Date(Date.now() + 7 * 86_400_000);
    await snoozeCommitment(db, { ownerId, commitmentId: id, until });

    const row = await getCommitment(id);
    expect(row.status).toBe("candidate");
    expect(row.snoozedUntil).not.toBeNull();

    expect((await latestAction())!.action).toBe("commitment_snoozed");
    expect(await db.select().from(extractionLabels).where(eq(extractionLabels.ownerId, ownerId))).toHaveLength(0);

    // snoozed candidates leave the queue, wake by query
    expect((await listCandidates(db, ownerId)).map((c) => c.id)).not.toContain(id);
  });
});

describe("addManualCommitment", () => {
  it("skips candidate state: lands open with confirmed_at, no label", async () => {
    const id = await addManualCommitment(db, {
      ownerId,
      direction: "owed_by_me",
      description: "send Q3 invoice",
      dueDate: "2026-06-20",
    });
    const row = await getCommitment(id);
    expect(row.status).toBe("open");
    expect(row.sourceType).toBe("manual");
    expect(row.confirmedAt).not.toBeNull();
    expect(row.confidence).toBeNull();
    expect((await latestAction())!.action).toBe("commitment_added");
    expect(await db.select().from(extractionLabels).where(eq(extractionLabels.ownerId, ownerId))).toHaveLength(0);
  });
});

describe("ledger views", () => {
  it("open / owed_to_me / snoozed are disjoint predicates over status + snoozed_until", async () => {
    const a = await seedCandidate();
    await confirmCommitment(db, { ownerId, commitmentId: a }); // open, owed_to_me
    const b = await addManualCommitment(db, { ownerId, direction: "owed_by_me", description: "pay invoice" });
    await snoozeCommitment(db, { ownerId, commitmentId: b, until: new Date(Date.now() + 86_400_000) });

    const open = await listLedger(db, ownerId, "open");
    expect(open.map((c) => c.id)).toEqual([a]); // snoozed b excluded
    const owedToMe = await listLedger(db, ownerId, "owed_to_me");
    expect(owedToMe.map((c) => c.id)).toEqual([a]);
    const snoozed = await listLedger(db, ownerId, "snoozed");
    expect(snoozed.map((c) => c.id)).toEqual([b]);
  });
});
