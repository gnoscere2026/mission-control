import { and, eq, inArray } from "drizzle-orm";
import { episodes, googleAccounts, type Db } from "@mission-control/db";
import { GmailHistoryGoneError, type GmailClient, type GmailMessage } from "./gmail-client";
import { parseAddress, resolvePerson } from "./people";

// Gmail History-API incremental sync with 404 fallback (ARCHITECTURE §2.3).
// Initial sync at connect = the same fallback path bounded to 30 days, writing
// episodes + people but NEVER enqueueing extraction — backfilled history is
// context, not a confirmation-queue flood (R3).

const BACKFILL_DAYS = 30;
const FALLBACK_OVERLAP_MS = 60 * 60 * 1000; // 1h overlap; upserts converge

export interface GmailSyncDeps {
  client: GmailClient;
  now?: Date;
}

export interface GmailSyncResult {
  mode: "initial_backfill" | "incremental" | "cursor_fallback";
  newEpisodeIds: string[];
  extractEpisodeIds: string[];
  messagesSeen: number;
  quotaUnits: number;
}

export async function syncGmail(
  db: Db,
  ownerId: string,
  accountId: string,
  deps: GmailSyncDeps,
): Promise<GmailSyncResult> {
  const { client } = deps;
  const now = deps.now ?? new Date();

  const [account] = await db
    .select()
    .from(googleAccounts)
    .where(and(eq(googleAccounts.ownerId, ownerId), eq(googleAccounts.id, accountId)));
  if (!account) throw new Error(`google account ${accountId} not found for owner`);

  let quotaUnits = 0;
  let mode: GmailSyncResult["mode"];
  let messageIds: string[] = [];
  let nextCursor: string | undefined;

  async function listByQuery(sinceMs: number): Promise<string[]> {
    const q = `after:${Math.floor(sinceMs / 1000)}`;
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      const page = await client.listMessageIds(q, pageToken);
      quotaUnits += 5;
      ids.push(...page.ids);
      pageToken = page.nextPageToken;
    } while (pageToken);
    return [...new Set(ids)];
  }

  if (!account.gmailHistoryId) {
    mode = "initial_backfill";
    messageIds = await listByQuery(now.getTime() - BACKFILL_DAYS * 86_400_000);
  } else {
    try {
      mode = "incremental";
      let pageToken: string | undefined;
      const ids: string[] = [];
      do {
        const page = await client.listHistory(account.gmailHistoryId, pageToken);
        quotaUnits += 2;
        ids.push(...page.messageIds);
        nextCursor = page.historyId;
        pageToken = page.nextPageToken;
      } while (pageToken);
      messageIds = [...new Set(ids)];
    } catch (err) {
      if (!(err instanceof GmailHistoryGoneError)) throw err;
      mode = "cursor_fallback";
      const since =
        (account.gmailLastSyncAt?.getTime() ?? now.getTime() - BACKFILL_DAYS * 86_400_000) -
        FALLBACK_OVERLAP_MS;
      messageIds = await listByQuery(since);
      nextCursor = undefined; // reset from profile below
    }
  }

  // Skip already-ingested messages before spending messages.get quota.
  const known = new Set<string>();
  for (let i = 0; i < messageIds.length; i += 200) {
    const chunk = messageIds.slice(i, i + 200);
    const rows = await db
      .select({ rawRef: episodes.rawRef })
      .from(episodes)
      .where(
        and(
          eq(episodes.ownerId, ownerId),
          eq(episodes.source, "gmail"),
          inArray(episodes.rawRef, chunk),
        ),
      );
    for (const r of rows) if (r.rawRef) known.add(r.rawRef);
  }
  const freshIds = messageIds.filter((id) => !known.has(id));

  const ownerEmails = new Set(
    [account.email, ...(process.env.USER_EMAIL ? [process.env.USER_EMAIL] : [])].map((e) =>
      e.toLowerCase(),
    ),
  );

  const newEpisodeIds: string[] = [];
  for (const id of freshIds) {
    const msg = await client.getMessage(id);
    quotaUnits += 5;
    const personId = await resolveCounterpartPerson(db, ownerId, msg, ownerEmails);
    const [inserted] = await db
      .insert(episodes)
      .values({
        ownerId,
        occurredAt: new Date(msg.internalDate),
        type: "email_received",
        source: "gmail",
        summary: msg.subject || msg.snippet.slice(0, 140),
        rawRef: msg.id,
        payload: {
          from: msg.from,
          to: msg.to,
          subject: msg.subject,
          snippet: msg.snippet,
          bodyExcerpt: msg.bodyExcerpt,
          threadId: msg.threadId,
        },
        relatedPersonIds: personId ? [personId] : [],
      })
      .onConflictDoNothing()
      .returning({ id: episodes.id });
    if (inserted) newEpisodeIds.push(inserted.id);
  }

  if (mode !== "incremental" || !nextCursor) {
    const profile = await client.getProfile();
    quotaUnits += 1;
    nextCursor = profile.historyId;
  }
  await db
    .update(googleAccounts)
    .set({ gmailHistoryId: nextCursor, gmailLastSyncAt: now, updatedAt: new Date() })
    .where(and(eq(googleAccounts.ownerId, ownerId), eq(googleAccounts.id, accountId)));

  return {
    mode,
    newEpisodeIds,
    extractEpisodeIds: mode === "initial_backfill" ? [] : newEpisodeIds,
    messagesSeen: messageIds.length,
    quotaUnits,
  };
}

// Sender for received mail; first recipient for owner-sent mail — the related
// person is always the counterparty, never the owner.
async function resolveCounterpartPerson(
  db: Db,
  ownerId: string,
  msg: GmailMessage,
  ownerEmails: Set<string>,
): Promise<string | null> {
  const sender = msg.from ? parseAddress(msg.from) : undefined;
  const occurredAt = new Date(msg.internalDate);
  if (sender && !ownerEmails.has(sender.email)) {
    return resolvePerson(db, ownerId, sender, occurredAt);
  }
  const firstRecipient = msg.to.split(",")[0]?.trim();
  if (firstRecipient) {
    const addr = parseAddress(firstRecipient);
    if (addr.email && !ownerEmails.has(addr.email)) {
      return resolvePerson(db, ownerId, addr, occurredAt);
    }
  }
  return null;
}
