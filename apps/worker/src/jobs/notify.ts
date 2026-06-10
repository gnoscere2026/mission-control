import type { Processor } from "bullmq";
import {
  appendRunStep,
  getBriefForDelivery,
  markBriefEmailed,
  markBriefPushed,
  renderBriefEmail,
  withCadenceRun,
} from "@mission-control/core";
import { createSmtpSender, type EmailSender } from "../delivery/email";
import { createWebPushClient, sendPushToOwner, type WebPushClient } from "../delivery/push";
import type { JobContext } from "./index";

export interface NotifyDeps {
  email?: EmailSender;
  push?: WebPushClient;
}

function appUrl(): string {
  return process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
}

// Delivery contract (invariant 7): the email mirror is the contractual backstop —
// its failure fails the run (red on /runs, BullMQ retries). Push is best-effort:
// a push failure is a failed run STEP (degraded delivery, visible per channel),
// never a failed run.
//
// Per-channel retry semantics (MC-204): each channel checks whether it was already
// delivered (emailedAt / pushedAt set on the brief) before attempting. A BullMQ
// retry after partial failure will skip already-delivered channels — no double-sends.
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
      async (runId) => {
        const brief = await getBriefForDelivery(ctx.db, ctx.owner.id, briefId);
        if (!brief) throw new Error(`brief ${briefId} not found for delivery`);
        const rendered = renderBriefEmail(brief);

        // channel 1: email mirror (required) — skipped if a previous attempt delivered it,
        // so a BullMQ retry after partial failure never double-sends (MC-204).
        if (brief.emailedAt) {
          await appendRunStep(ctx.db, {
            runId, seq: 1, name: "email", status: "skipped",
            startedAt: new Date(), detail: { reason: "already_emailed" },
          });
        } else {
          const emailStart = new Date();
          try {
            const email = deps.email ?? createSmtpSender();
            await email.send(rendered);
          } catch (err) {
            await appendRunStep(ctx.db, {
              runId, seq: 1, name: "email", status: "failed",
              startedAt: emailStart, detail: { error: String(err) },
            });
            throw err; // fails the run → red row + retry with backoff
          }
          await markBriefEmailed(ctx.db, ctx.owner.id, briefId);
          await appendRunStep(ctx.db, { runId, seq: 1, name: "email", status: "ok", startedAt: emailStart });
        }

        // channel 2: web push (best-effort) — same skip guard (MC-204).
        let pushed = Boolean(brief.pushedAt);
        if (brief.pushedAt) {
          await appendRunStep(ctx.db, {
            runId, seq: 2, name: "push", status: "skipped",
            startedAt: new Date(), detail: { reason: "already_pushed" },
          });
        } else {
          const pushStart = new Date();
          try {
            const client = deps.push ?? createWebPushClient();
            const result = await sendPushToOwner(ctx.db, ctx.owner.id, {
              title: rendered.subject,
              body: "Your brief is ready.",
              url: `${appUrl()}/briefs/${briefId}`,
            }, client);
            pushed = result.sent > 0;
            if (pushed) await markBriefPushed(ctx.db, ctx.owner.id, briefId);
            await appendRunStep(ctx.db, {
              runId, seq: 2, name: "push",
              status: result.attempted === 0 ? "skipped" : pushed ? "ok" : "failed",
              startedAt: pushStart, detail: result,
            });
          } catch (err) {
            await appendRunStep(ctx.db, {
              runId, seq: 2, name: "push", status: "failed",
              startedAt: pushStart, detail: { error: String(err) },
            });
          }
        }

        return { emailed: true, pushed, briefId };
      },
    );
  };
}
