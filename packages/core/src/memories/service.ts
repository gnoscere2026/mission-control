import { and, asc, cosineDistance, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { memories, type Db } from "@mission-control/db";
import { embed } from "@mission-control/llm";
import { appendUserAction } from "../activity";

export interface CreateMemoryArgs {
  ownerId: string;
  content: string;
  source: "manual_pin" | "chat" | "extraction" | "system";
  sourceEpisodeId?: string | null;
  pinned?: boolean;
  runId?: string | null;
  embedImpl?: typeof embed;
}

// MC-201 write path: embed-then-insert. Manual pins are a user disposition,
// so they land in user_actions; system/extraction writes do not.
export async function createMemory(db: Db, args: CreateMemoryArgs): Promise<{ memoryId: string }> {
  const embedImpl = args.embedImpl ?? embed;
  const result = await embedImpl({
    db,
    ownerId: args.ownerId,
    task: "embed.memory",
    input: [args.content],
    inputType: "document",
    runId: args.runId ?? null,
    dataCategories: ["memory"],
  });
  const [row] = await db
    .insert(memories)
    .values({
      ownerId: args.ownerId,
      content: args.content,
      embedding: result.embeddings[0],
      embeddingModel: result.model,
      sourceEpisodeId: args.sourceEpisodeId ?? null,
      source: args.source,
      pinned: args.pinned ?? args.source === "manual_pin",
    })
    .returning({ id: memories.id });
  if (!row) throw new Error("memory insert returned no row");

  if (args.source === "manual_pin") {
    await appendUserAction(db, {
      ownerId: args.ownerId,
      action: "memory_pinned",
      entityType: "memory",
      entityId: row.id,
      payload: { sourceEpisodeId: args.sourceEpisodeId ?? null },
    });
  }
  return { memoryId: row.id };
}

export interface RetrieveMemoriesArgs {
  ownerId: string;
  queryEmbedding: number[];
  k?: number;
  now?: Date;
}

export interface RetrievedMemory {
  id: string;
  content: string;
  pinned: boolean;
  similarity: number | null; // null for pinned rows included regardless of vector
  score: number;
  createdAt: Date;
}

const SIMILARITY_WEIGHT = 0.8;
const RECENCY_WEIGHT = 0.2;
const RECENCY_HALF_LIFE_DAYS = 30;

// Retrieval (MC-201): cosine top-k over active memories (the HNSW index exists,
// but pgvector post-filters WHERE clauses — fine at v1 corpus size; revisit the
// index strategy if the corpus outgrows a sequential distance scan). Blended
// with recency in JS (deterministic, tie-broken by id); pinned active memories
// always ride along. Touches last_used_at on everything returned.
export async function retrieveMemories(db: Db, args: RetrieveMemoriesArgs): Promise<RetrievedMemory[]> {
  const k = args.k ?? 8;
  const now = args.now ?? new Date();

  const pinnedRows = await db
    .select({ id: memories.id, content: memories.content, pinned: memories.pinned, createdAt: memories.createdAt })
    .from(memories)
    .where(and(eq(memories.ownerId, args.ownerId), eq(memories.status, "active"), eq(memories.pinned, true)))
    .orderBy(asc(memories.createdAt), asc(memories.id));

  const similarityExpr = sql<number>`1 - (${cosineDistance(memories.embedding, args.queryEmbedding)})`;
  const candidates = await db
    .select({
      id: memories.id,
      content: memories.content,
      pinned: memories.pinned,
      createdAt: memories.createdAt,
      similarity: similarityExpr,
    })
    .from(memories)
    .where(
      and(
        eq(memories.ownerId, args.ownerId),
        eq(memories.status, "active"),
        eq(memories.pinned, false),
        isNotNull(memories.embedding),
      ),
    )
    .orderBy(desc(similarityExpr), asc(memories.id))
    .limit(k * 3);

  const blended = candidates
    .map((r) => {
      const ageDays = Math.max(0, (now.getTime() - r.createdAt.getTime()) / 86_400_000);
      const recency = Math.exp(-ageDays / RECENCY_HALF_LIFE_DAYS);
      return {
        ...r,
        similarity: Number(r.similarity),
        score: SIMILARITY_WEIGHT * Number(r.similarity) + RECENCY_WEIGHT * recency,
      };
    })
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, k);

  const result: RetrievedMemory[] = [
    ...pinnedRows.map((p) => ({ ...p, similarity: null, score: 1 })),
    ...blended,
  ];

  const ids = result.map((r) => r.id);
  if (ids.length > 0) {
    await db
      .update(memories)
      .set({ lastUsedAt: now })
      .where(and(eq(memories.ownerId, args.ownerId), inArray(memories.id, ids)));
  }
  return result;
}
