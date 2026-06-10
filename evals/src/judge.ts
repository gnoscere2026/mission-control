import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { complete } from "@mission-control/llm";
import type { Db } from "@mission-control/db";
import type { Judge } from "./match";

// EVAL-SPEC §2.4: judge verdicts are cached in a committed JSON file keyed by
// hash(pred, gold), so reruns are deterministic and free.

export const JUDGE_CACHE_PATH = path.join(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")),
  "..",
  ".judge-cache.json",
);

const JudgeVerdict = z.object({ same_obligation: z.boolean() });

export function makeCachedJudge(
  db: Db,
  ownerId: string,
  cachePath = JUDGE_CACHE_PATH,
): { judge: Judge; flush: () => void; misses: () => number } {
  const cache: Record<string, boolean> = existsSync(cachePath)
    ? (JSON.parse(readFileSync(cachePath, "utf8")) as Record<string, boolean>)
    : {};
  let dirty = false;
  let missCount = 0;

  const judge: Judge = async (pred, gold) => {
    const key = createHash("sha256").update(`${pred}|${gold}`).digest("hex");
    if (key in cache) return cache[key]!;
    missCount++;
    const { data } = await complete({
      db,
      ownerId,
      task: "eval.match_judge",
      schema: JudgeVerdict,
      prompt: `Do these two phrases describe the same obligation?\nA: ${pred}\nB: ${gold}\nAnswer via the tool with same_obligation true or false.`,
      dataCategories: ["capture"],
    });
    cache[key] = data.same_obligation;
    dirty = true;
    return data.same_obligation;
  };

  return {
    judge,
    misses: () => missCount,
    flush: () => {
      if (!dirty) return;
      const sorted = Object.fromEntries(Object.entries(cache).sort(([a], [b]) => a.localeCompare(b)));
      writeFileSync(cachePath, JSON.stringify(sorted, null, 2) + "\n");
      dirty = false;
    },
  };
}
