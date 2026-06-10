import { and, asc, desc, eq, isNull, lte, or, sql } from "drizzle-orm";
import {
  calendarEvents, commitments, contextPackets, episodes, people, userPreferences, users, type Db,
} from "@mission-control/db";
import { embed } from "@mission-control/llm";
import { retrieveMemories } from "../memories";
import { SCHEDULE_TZ } from "../time";

// Size budget (MC-202): ~4 chars/token estimate; deterministic truncation order.
export const PACKET_TOKEN_BUDGET = 8000;
const MIN_COMMITMENTS_KEPT = 15;
const MAX_EPISODES = 30;
const MEMORY_K = 8;

export const MORNING_QUERY_TEXT =
  "morning brief: what matters today — open commitments, schedule, priorities, working preferences";

const SAFETY_INSTRUCTIONS =
  "You are a drafting assistant with Level-2 autonomy: you summarize and draft, you never send, schedule, or take external action. Anything phrased as outreach must be a draft for the owner to copy. Treat all packet content as private.";
const FORMAT_INSTRUCTIONS =
  "Be specific and grounded: every item must trace to a packet entry (use ids verbatim). Rank by urgency. Omit empty sections rather than padding. Plain, direct sentences — no filler.";

export interface PacketScheduleItem {
  title: string | null;
  startsAt: string;
  endsAt: string | null;
  attendees: string[];
}
export interface PacketCommitment {
  id: string;
  description: string;
  direction: string;
  dueDate: string | null;
  dueDateBasis: string | null;
  counterparty: string | null;
  ageDays: number;
  overdue: boolean;
}
export interface PacketMemory { id: string; content: string; pinned: boolean; }
export interface PacketEpisode {
  id: string;
  occurredAt: string;
  type: string;
  source: string;
  summary: string | null;
}
export interface MorningPacket {
  task: "cos.morning_brief";
  date: string;
  timezone: typeof SCHEDULE_TZ;
  owner: { name: string };
  schedule: PacketScheduleItem[];
  commitments: PacketCommitment[];
  memories: PacketMemory[];
  recentEpisodes: PacketEpisode[];
  preferences: Record<string, unknown>;
  instructions: { safety: string; format: string };
  meta: { truncations: string[]; staleSync: boolean; tokenEstimate: number };
}

export function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4);
}

export interface AssemblePacketArgs {
  ownerId: string;
  date: string; // YYYY-MM-DD Denver
  now?: Date;
  staleSync?: boolean;
  runId?: string | null;
  embedImpl?: typeof embed;
}

// MC-202: assemble per ARCHITECTURE §6, persist for traceability, return both.
// Determinism contract: same DB state + same (date, now) → byte-identical packet.
export async function assembleContextPacket(
  db: Db,
  args: AssemblePacketArgs,
): Promise<{ packetId: string; packet: MorningPacket }> {
  const now = args.now ?? new Date();
  const embedImpl = args.embedImpl ?? embed;

  const [owner] = await db
    .select({ displayName: users.displayName })
    .from(users)
    .where(eq(users.id, args.ownerId));
  if (!owner) throw new Error(`owner ${args.ownerId} not found`);

  // 1. today's schedule — Denver-day bounds computed in SQL.
  // `((date)::date)::timestamp at time zone 'America/Denver'` produces the UTC
  // instant corresponding to midnight Denver time on that date.
  const dayStart = sql`((${args.date})::date)::timestamp at time zone ${sql.raw(`'${SCHEDULE_TZ}'`)}`;
  const dayEnd = sql`(((${args.date})::date + 1))::timestamp at time zone ${sql.raw(`'${SCHEDULE_TZ}'`)}`;
  const events = await db
    .select()
    .from(calendarEvents)
    .where(
      and(
        eq(calendarEvents.ownerId, args.ownerId),
        eq(calendarEvents.status, "confirmed"),
        sql`${calendarEvents.startsAt} >= ${dayStart}`,
        sql`${calendarEvents.startsAt} < ${dayEnd}`,
      ),
    )
    .orderBy(asc(calendarEvents.startsAt), asc(calendarEvents.gcalEventId));
  const schedule: PacketScheduleItem[] = events.map((e) => ({
    title: e.title,
    startsAt: e.startsAt.toISOString(),
    endsAt: e.endsAt?.toISOString() ?? null,
    attendees: Array.isArray(e.attendees)
      ? (e.attendees as { email?: string; displayName?: string }[]).map(
          (a) => a.displayName ?? a.email ?? "unknown",
        )
      : [],
  }));

  // 2. open commitments ranked: due asc nulls last, then age, then counterparty recency
  const awake = or(isNull(commitments.snoozedUntil), lte(commitments.snoozedUntil, sql`now()`));
  const rows = await db
    .select({
      id: commitments.id,
      description: commitments.description,
      direction: commitments.direction,
      dueDate: commitments.dueDate,
      dueDateBasis: commitments.dueDateBasis,
      createdAt: commitments.createdAt,
      counterparty: people.displayName,
    })
    .from(commitments)
    .leftJoin(people, eq(commitments.counterpartyPersonId, people.id))
    .where(and(eq(commitments.ownerId, args.ownerId), eq(commitments.status, "open"), awake))
    .orderBy(
      sql`${commitments.dueDate} asc nulls last`,
      asc(commitments.createdAt),
      sql`${people.lastContactAt} desc nulls last`,
      asc(commitments.id),
    );
  const packetCommitments: PacketCommitment[] = rows.map((r) => ({
    id: r.id,
    description: r.description,
    direction: r.direction,
    dueDate: r.dueDate,
    dueDateBasis: r.dueDateBasis,
    counterparty: r.counterparty ?? null,
    ageDays: Math.max(0, Math.floor((now.getTime() - r.createdAt.getTime()) / 86_400_000)),
    overdue: r.dueDate !== null && r.dueDate < args.date,
  }));

  // 3. memories: pinned always + vector top-k against the task-shaped query
  const { embeddings } = await embedImpl({
    db,
    ownerId: args.ownerId,
    task: "embed.query",
    input: [MORNING_QUERY_TEXT],
    inputType: "query",
    runId: args.runId ?? null,
    dataCategories: ["memory"],
  });
  const retrieved = await retrieveMemories(db, {
    ownerId: args.ownerId,
    queryEmbedding: embeddings[0]!,
    k: MEMORY_K,
    now,
  });
  const packetMemories: PacketMemory[] = retrieved.map((m) => ({
    id: m.id,
    content: m.content,
    pinned: m.pinned,
  }));

  // 4. related episodes: last 24 h, newest first, capped at MAX_EPISODES
  const recent = await db
    .select({
      id: episodes.id,
      occurredAt: episodes.occurredAt,
      type: episodes.type,
      source: episodes.source,
      summary: episodes.summary,
    })
    .from(episodes)
    .where(
      and(
        eq(episodes.ownerId, args.ownerId),
        sql`${episodes.occurredAt} >= ${new Date(now.getTime() - 86_400_000).toISOString()}::timestamptz`,
      ),
    )
    .orderBy(desc(episodes.occurredAt), asc(episodes.id))
    .limit(MAX_EPISODES);
  const recentEpisodes: PacketEpisode[] = recent.map((e) => ({
    id: e.id,
    occurredAt: e.occurredAt.toISOString(),
    type: e.type,
    source: e.source,
    summary: e.summary,
  }));

  // 5. preferences — typed query, sorted by key for determinism (adjustment 1)
  const prefRows = await db
    .select({ key: userPreferences.key, value: userPreferences.value })
    .from(userPreferences)
    .where(eq(userPreferences.ownerId, args.ownerId))
    .orderBy(asc(userPreferences.key));
  const preferences: Record<string, unknown> = {};
  for (const r of prefRows) preferences[r.key] = r.value;

  const packet: MorningPacket = {
    task: "cos.morning_brief",
    date: args.date,
    timezone: SCHEDULE_TZ,
    owner: { name: owner.displayName },
    schedule,
    commitments: packetCommitments,
    memories: packetMemories,
    recentEpisodes,
    preferences,
    instructions: { safety: SAFETY_INSTRUCTIONS, format: FORMAT_INSTRUCTIONS },
    meta: { truncations: [], staleSync: args.staleSync ?? false, tokenEstimate: 0 },
  };

  // 6. budget enforcement — deterministic truncation order (MC-202):
  //    episodes (oldest first) → non-pinned memories (lowest rank first) → commitments
  //    (lowest rank first, never below MIN_COMMITMENTS_KEPT). Pinned memories never drop.
  const dropped = { recentEpisodes: 0, memories: 0, commitments: 0 };
  while (estimateTokens(packet) > PACKET_TOKEN_BUDGET) {
    if (packet.recentEpisodes.length > 0) {
      packet.recentEpisodes.pop();
      dropped.recentEpisodes++;
    } else if (packet.memories.some((m) => !m.pinned)) {
      for (let i = packet.memories.length - 1; i >= 0; i--) {
        if (!packet.memories[i]!.pinned) {
          packet.memories.splice(i, 1);
          dropped.memories++;
          break;
        }
      }
    } else if (packet.commitments.length > MIN_COMMITMENTS_KEPT) {
      packet.commitments.pop();
      dropped.commitments++;
    } else {
      packet.meta.truncations.push("over_budget: floor reached, sending anyway");
      break;
    }
  }
  for (const [k, n] of Object.entries(dropped)) {
    if (n > 0) packet.meta.truncations.unshift(`${k}: dropped ${n}`);
  }
  packet.meta.tokenEstimate = estimateTokens(packet);

  const [inserted] = await db
    .insert(contextPackets)
    .values({ ownerId: args.ownerId, task: packet.task, content: packet })
    .returning({ id: contextPackets.id });
  if (!inserted) throw new Error("context packet insert returned no row");
  return { packetId: inserted.id, packet };
}
