import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { commitments, episodes, googleAccounts, people, users, type Db } from "@mission-control/db";
import { complete } from "@mission-control/llm";
import { resolvePerson } from "../ingest/people";
import { ACTIVE_EXTRACTION } from "./active";
import type { ExtractionInput, ExtractionPromptModule } from "./extract_commitments.v1";

// Idempotency key for extraction writes (SCHEMA §2.2): hash(source_ref,
// normalized description) — version-free, so a prompt bump can't duplicate
// already-dispositioned candidates.
export function normalizeDescription(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function extractionHash(sourceRef: string, description: string): string {
  return createHash("sha256")
    .update(`${sourceRef}|${normalizeDescription(description)}`)
    .digest("hex");
}

const SOURCE_TYPE_BY_EPISODE_SOURCE: Record<string, "email" | "calendar" | "chat" | "manual"> = {
  gmail: "email",
  gcal: "calendar",
  chat: "chat",
  manual: "manual",
};

export interface ExtractFromEpisodeArgs {
  ownerId: string;
  episodeId: string;
  runId?: string;
  force?: boolean;
  completeImpl?: typeof complete;
  promptModule?: ExtractionPromptModule;
}

export interface ExtractFromEpisodeResult {
  status: "skipped_existing" | "done";
  created: number;
  duplicates: number;
}

export async function extractCommitmentsFromEpisode(
  db: Db,
  args: ExtractFromEpisodeArgs,
): Promise<ExtractFromEpisodeResult> {
  const completeImpl = args.completeImpl ?? complete;
  const prompt = args.promptModule ?? ACTIVE_EXTRACTION;

  const [episode] = await db
    .select()
    .from(episodes)
    .where(and(eq(episodes.ownerId, args.ownerId), eq(episodes.id, args.episodeId)));
  if (!episode) throw new Error(`episode ${args.episodeId} not found for owner`);

  // Episode guard (MC-104): episodes are immutable, so re-extraction is never
  // new information. A prompt-version bump must not re-process old episodes.
  if (!args.force) {
    const [{ count }] = (await db
      .select({ count: sql<number>`count(*)::int` })
      .from(commitments)
      .where(
        and(eq(commitments.ownerId, args.ownerId), eq(commitments.sourceEpisodeId, episode.id)),
      )) as [{ count: number }];
    if (count > 0) return { status: "skipped_existing", created: 0, duplicates: 0 };
  }

  const [owner] = await db.select().from(users).where(eq(users.id, args.ownerId));
  if (!owner) throw new Error(`owner ${args.ownerId} not found`);
  const accounts = await db
    .select({ email: googleAccounts.email })
    .from(googleAccounts)
    .where(eq(googleAccounts.ownerId, args.ownerId));
  const ownerEmails = [...new Set([owner.email, ...accounts.map((a) => a.email)])];

  const payload = (episode.payload ?? {}) as {
    from?: string;
    to?: string;
    subject?: string;
    bodyExcerpt?: string;
    text?: string;
  };
  const input: ExtractionInput = {
    sourceType: SOURCE_TYPE_BY_EPISODE_SOURCE[episode.source] ?? "manual",
    ownerName: owner.displayName,
    ownerEmails,
    from: payload.from,
    to: payload.to,
    subject: payload.subject,
    occurredAt: episode.occurredAt.toISOString(),
    body: payload.bodyExcerpt ?? payload.text ?? episode.summary ?? "",
  };

  const { data } = await completeImpl({
    db,
    ownerId: args.ownerId,
    task: prompt.task,
    schema: prompt.schema,
    system: prompt.system,
    prompt: prompt.renderPrompt(input),
    runId: args.runId ?? null,
    promptVersion: prompt.version,
    dataCategories: [input.sourceType === "email" ? "email" : "capture"],
  });

  const sourceRefForHash = episode.rawRef ?? episode.id;
  let created = 0;
  let duplicates = 0;

  for (const c of data.commitments) {
    let counterpartyPersonId: string | null = null;
    if (c.counterparty_email && !ownerEmails.includes(c.counterparty_email.toLowerCase())) {
      counterpartyPersonId = await resolvePerson(
        db,
        args.ownerId,
        {
          email: c.counterparty_email,
          ...(c.counterparty_name ? { name: c.counterparty_name } : {}),
        },
        episode.occurredAt,
      );
    } else if (c.counterparty_name) {
      counterpartyPersonId = await findOrCreatePersonByName(
        db,
        args.ownerId,
        c.counterparty_name,
      );
    }

    const [inserted] = await db
      .insert(commitments)
      .values({
        ownerId: args.ownerId,
        direction: c.direction,
        counterpartyPersonId,
        description: c.description,
        sourceType: input.sourceType,
        sourceEpisodeId: episode.id,
        sourceRef: episode.rawRef,
        sourceExcerpt: c.source_excerpt,
        dueDate: c.due_date,
        dueDateBasis: c.due_date ? c.due_date_basis : null,
        status: "candidate",
        confidence: c.confidence,
        extractionHash: extractionHash(sourceRefForHash, c.description),
        promptVersion: prompt.version,
      })
      .onConflictDoNothing()
      .returning({ id: commitments.id });
    if (inserted) created++;
    else duplicates++;
  }

  return { status: "done", created, duplicates };
}

// Chat captures often name people without an email ("told Sara…"); match an
// existing person case-insensitively by display name, else create email-less.
async function findOrCreatePersonByName(db: Db, ownerId: string, name: string): Promise<string> {
  const [existing] = await db
    .select({ id: people.id })
    .from(people)
    .where(
      and(eq(people.ownerId, ownerId), sql`lower(${people.displayName}) = ${name.toLowerCase()}`),
    );
  if (existing) return existing.id;
  const [created] = await db
    .insert(people)
    .values({ ownerId, displayName: name, emails: [] })
    .returning({ id: people.id });
  if (!created) throw new Error("person insert returned no row");
  return created.id;
}
