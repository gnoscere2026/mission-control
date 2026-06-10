import type { Processor } from "bullmq";
import {
  appendRunStep,
  createGcalClient,
  createGmailClient,
  dateKeyInDenver,
  generateMorningBrief,
  getValidAccessToken,
  listGoogleAccounts,
  syncGcal,
  syncGmail,
  withCadenceRun,
} from "@mission-control/core";
import type { JobContext } from "./index";

export interface BriefsDeps {
  generateImpl?: typeof generateMorningBrief;
  syncGmailImpl?: typeof syncGmail;
  syncGcalImpl?: typeof syncGcal;
}

// Two-layer idempotency (ARCHITECTURE §5.2):
//  1. deterministic jobId `morning-brief-<date>` — re-enqueueing is a BullMQ no-op
//     (":" is not allowed in custom jobIds, hence "-" separators);
//  2. briefs dedupe key `morning:<date>` — even a duplicate execution converges.
export function makeBriefsProcessor(ctx: JobContext, deps: BriefsDeps = {}): Processor {
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
            // step 1: inline pre-sync — 7 AM is outside the ingest window (ARCHITECTURE §5.1).
            // Failure degrades to stale data; it never skips the brief.
            const presyncStart = new Date();
            let staleSync = false;
            const detail: Record<string, unknown> = {};
            try {
              const accounts = await listGoogleAccounts(ctx.db, ctx.owner.id);
              detail.accounts = accounts.length;
              for (const account of accounts) {
                if (account.status === "reauth_required") {
                  staleSync = true;
                  detail[account.email] = "reauth_required";
                  continue;
                }
                const gmailClient = createGmailClient(() =>
                  getValidAccessToken(ctx.db, ctx.owner.id, account.id),
                );
                const gmail = await (deps.syncGmailImpl ?? syncGmail)(ctx.db, ctx.owner.id, account.id, {
                  client: gmailClient,
                });
                for (const episodeId of gmail.extractEpisodeIds) {
                  await ctx.queues.extraction.add(
                    "extract_commitments",
                    { episodeId },
                    { jobId: `extract-episode-${episodeId}` },
                  );
                }
                const gcalClient = createGcalClient(() =>
                  getValidAccessToken(ctx.db, ctx.owner.id, account.id),
                );
                await (deps.syncGcalImpl ?? syncGcal)(ctx.db, ctx.owner.id, account.id, {
                  client: gcalClient,
                });
                detail[account.email] = "synced";
              }
            } catch (err) {
              staleSync = true;
              detail.error = String(err);
            }
            await appendRunStep(ctx.db, {
              runId,
              seq: 1,
              name: "presync",
              status: staleSync ? "failed" : "ok",
              startedAt: presyncStart,
              detail,
            });

            // step 2: assemble + generate. A throw here fails the run — no brief, no notify.
            const generate = deps.generateImpl ?? generateMorningBrief;
            const result = await generate(ctx.db, {
              ownerId: ctx.owner.id,
              date,
              cadenceRunId: runId,
              staleSync,
            });
            if (result.created) {
              await ctx.queues.notify.add(
                "deliver_brief",
                { briefId: result.briefId },
                { jobId: `notify-${result.briefId}` },
              );
            }
            return { ...result, staleSync };
          },
        );
      }

      default:
        throw new Error(`unknown briefs job "${job.name}" (${job.id})`);
    }
  };
}
