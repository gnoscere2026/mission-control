import type { Processor } from "bullmq";
import {
  getBriefForDelivery,
  markBriefEmailed,
  renderBriefEmail,
  withCadenceRun,
} from "@mission-control/core";
import { createSmtpSender, type EmailSender } from "../delivery/email";
import type { JobContext } from "./index";

export interface NotifyDeps {
  email?: EmailSender;
  // push sender slots in with MC-006 (Task 11)
}

// Delivery contract (invariant 7): the email mirror is the contractual backstop —
// its failure fails the run (red on /runs). Push (MC-006) is best-effort and only
// degrades the run meta, never fails it.
export function makeNotifyProcessor(ctx: JobContext, deps: NotifyDeps = {}): Processor {
  return async (job) => {
    if (job.name !== "deliver_brief") {
      throw new Error(`unknown notify job "${job.name}" (${job.id})`);
    }
    const { briefId } = job.data as { briefId: string };
    const jobId = job.id ?? `notify-${briefId}`;

    return withCadenceRun(
      ctx.db,
      { ownerId: ctx.owner.id, jobName: "notify", jobId, attempt: job.attemptsMade + 1 },
      async () => {
        const brief = await getBriefForDelivery(ctx.db, ctx.owner.id, briefId);
        if (!brief) throw new Error(`brief ${briefId} not found for delivery`);

        const rendered = renderBriefEmail(brief);
        const email = deps.email ?? createSmtpSender();
        await email.send(rendered); // throws → failed run, BullMQ retries with backoff
        await markBriefEmailed(ctx.db, ctx.owner.id, briefId);

        return { emailed: true, briefId };
      },
    );
  };
}
