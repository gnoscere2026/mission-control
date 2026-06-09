import type { Processor } from "bullmq";
import { dateKeyInDenver, generateHelloBrief, withCadenceRun } from "@mission-control/core";
import type { JobContext } from "./index";

// Two-layer idempotency (ARCHITECTURE §5.2):
//  1. deterministic jobId `morning-brief-<date>` — re-enqueueing is a BullMQ no-op
//     (":" is not allowed in custom jobIds, hence "-" separators);
//  2. briefs dedupe key `morning:<date>` — even a duplicate execution converges.
export function makeBriefsProcessor(ctx: JobContext): Processor {
  return async (job) => {
    switch (job.name) {
      // Fired by the repeatable scheduler at 7:00 AM America/Denver; enqueues the
      // real job with its deterministic id so a crashed-and-restarted scheduler
      // cannot double-generate (BUILD-PLAN exit criterion 2).
      case "morning_brief_tick": {
        const date = dateKeyInDenver();
        return withCadenceRun(
          ctx.db,
          { ownerId: ctx.owner.id, jobName: "morning_brief_tick", jobId: `morning-brief-tick-${date}` },
          async () => {
            await ctx.queues.briefs.add("morning_brief", { date }, { jobId: `morning-brief-${date}` });
            return { enqueuedFor: date };
          },
        );
      }

      case "morning_brief": {
        const date: string = (job.data as { date?: string })?.date ?? dateKeyInDenver();
        const jobId = job.id ?? `morning-brief-${date}`;
        return withCadenceRun(
          ctx.db,
          { ownerId: ctx.owner.id, jobName: "morning_brief", jobId, attempt: job.attemptsMade + 1 },
          async (runId) => {
            const result = await generateHelloBrief(ctx.db, {
              ownerId: ctx.owner.id,
              date,
              cadenceRunId: runId,
            });
            if (result.created) {
              await ctx.queues.notify.add(
                "deliver_brief",
                { briefId: result.briefId },
                { jobId: `notify-${result.briefId}` },
              );
            }
            return result;
          },
        );
      }

      default:
        throw new Error(`unknown briefs job "${job.name}" (${job.id})`);
    }
  };
}
