import { UnrecoverableError, type Processor } from "bullmq";
import {
  appendRunStep,
  createGcalClient,
  createGmailClient,
  getGoogleAccount,
  getValidAccessToken,
  getWorkingHours,
  isWithinWorkingHours,
  listGoogleAccounts,
  quarterHourStampInDenver,
  ReauthRequiredError,
  syncGcal,
  syncGmail,
  withCadenceRun,
  type GcalSyncResult,
  type GmailSyncResult,
} from "@mission-control/core";
import { createWebPushClient, sendPushToOwner } from "../delivery/push";
import type { JobContext } from "./index";

export interface IngestDeps {
  syncGmailImpl?: (
    db: JobContext["db"],
    ownerId: string,
    accountId: string,
    deps: { client: ReturnType<typeof createGmailClient> },
  ) => Promise<GmailSyncResult>;
  syncGcalImpl?: (
    db: JobContext["db"],
    ownerId: string,
    accountId: string,
    deps: { client: ReturnType<typeof createGcalClient> },
  ) => Promise<GcalSyncResult>;
  sendReauthAlert?: (ctx: JobContext, email: string) => Promise<void>;
  now?: () => Date;
}

function appUrl(): string {
  return process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
}

// One alert per flip, not per tick: the alert fires only when the account was
// active at job start and invalid_grant surfaced during THIS run. Already-
// flagged accounts fail fast (UnrecoverableError → no retry crash-loop) and
// stay visible via the failed run + settings banner.
async function defaultReauthAlert(ctx: JobContext, email: string): Promise<void> {
  const client = createWebPushClient();
  await sendPushToOwner(
    ctx.db,
    ctx.owner.id,
    {
      title: "Google re-connect needed",
      body: `Mission Control lost access to ${email}. Tap to re-consent.`,
      url: `${appUrl()}/settings`,
    },
    client,
  );
}

export function makeIngestProcessor(ctx: JobContext, deps: IngestDeps = {}): Processor {
  const now = deps.now ?? (() => new Date());

  async function runAccountSync(
    jobName: "ingest_gmail" | "ingest_gcal",
    jobId: string,
    accountId: string,
    attempt: number,
  ) {
    return withCadenceRun(
      ctx.db,
      { ownerId: ctx.owner.id, jobName, jobId, attempt, meta: { accountId } },
      async (runId) => {
        const account = await getGoogleAccount(ctx.db, ctx.owner.id, accountId);
        if (!account) throw new UnrecoverableError(`google account ${accountId} not found`);
        if (account.status === "reauth_required") {
          // flagged on a previous run — fail fast, no Google calls, no re-alert
          throw new UnrecoverableError(`reauth_required: ${account.email}`);
        }

        const stepStart = new Date();
        try {
          if (jobName === "ingest_gmail") {
            const syncImpl = deps.syncGmailImpl ?? syncGmail;
            const client = createGmailClient(() =>
              getValidAccessToken(ctx.db, ctx.owner.id, accountId),
            );
            const result = await syncImpl(ctx.db, ctx.owner.id, accountId, { client });
            await appendRunStep(ctx.db, {
              runId,
              seq: 1,
              name: "sync",
              status: "ok",
              startedAt: stepStart,
              detail: {
                mode: result.mode,
                messagesSeen: result.messagesSeen,
                newEpisodes: result.newEpisodeIds.length,
                quotaUnits: result.quotaUnits,
              },
            });

            const enqueueStart = new Date();
            for (const episodeId of result.extractEpisodeIds) {
              await ctx.queues.extraction.add(
                "extract_commitments",
                { episodeId },
                { jobId: `extract-episode-${episodeId}` },
              );
            }
            await appendRunStep(ctx.db, {
              runId,
              seq: 2,
              name: "enqueue_extraction",
              status: "ok",
              startedAt: enqueueStart,
              detail: { enqueued: result.extractEpisodeIds.length },
            });
            return {
              mode: result.mode,
              newEpisodes: result.newEpisodeIds.length,
              extractionEnqueued: result.extractEpisodeIds.length,
            };
          }

          // ingest_gcal (MC-103): events + episodes; no extraction enqueue in Phase 1
          const syncImpl = deps.syncGcalImpl ?? syncGcal;
          const client = createGcalClient(() =>
            getValidAccessToken(ctx.db, ctx.owner.id, accountId),
          );
          const result = await syncImpl(ctx.db, ctx.owner.id, accountId, { client });
          await appendRunStep(ctx.db, {
            runId,
            seq: 1,
            name: "sync",
            status: "ok",
            startedAt: stepStart,
            detail: {
              mode: result.mode,
              eventsSeen: result.eventsSeen,
              newEpisodes: result.newEpisodeIds.length,
            },
          });
          return {
            mode: result.mode,
            eventsSeen: result.eventsSeen,
            newEpisodes: result.newEpisodeIds.length,
          };
        } catch (err) {
          if (err instanceof ReauthRequiredError) {
            // fresh flip: alert once, then fail without retries
            const alert = deps.sendReauthAlert ?? defaultReauthAlert;
            try {
              await alert(ctx, err.email);
            } catch (alertErr) {
              await appendRunStep(ctx.db, {
                runId,
                seq: 9,
                name: "reauth_alert",
                status: "failed",
                startedAt: new Date(),
                detail: { error: String(alertErr) },
              });
            }
            throw new UnrecoverableError(`reauth_required: ${err.email}`);
          }
          throw err;
        }
      },
    );
  }

  return async (job) => {
    switch (job.name) {
      case "ingest_tick": {
        const at = now();
        const hours = await getWorkingHours(ctx.db, ctx.owner.id);
        if (!isWithinWorkingHours(hours, at)) {
          // a skip is not a failure — no run row, no noise (96 ticks/day)
          return { skipped: "outside_working_hours" };
        }
        const stamp = quarterHourStampInDenver(at);
        return withCadenceRun(
          ctx.db,
          {
            ownerId: ctx.owner.id,
            jobName: "ingest_tick",
            jobId: job.id ?? `ingest-tick-${stamp}`,
          },
          async () => {
            const accounts = await listGoogleAccounts(ctx.db, ctx.owner.id);
            for (const account of accounts) {
              await ctx.queues.ingest.add(
                "ingest_gmail",
                { accountId: account.id },
                { jobId: `ingest-gmail-${account.id}-${stamp}` },
              );
              await ctx.queues.ingest.add(
                "ingest_gcal",
                { accountId: account.id },
                { jobId: `ingest-gcal-${account.id}-${stamp}` },
              );
            }
            return { accounts: accounts.length, stamp };
          },
        );
      }

      case "ingest_gmail":
      case "ingest_gcal": {
        const { accountId } = job.data as { accountId: string };
        if (!accountId) throw new UnrecoverableError(`${job.name} job missing accountId`);
        const jobId = job.id ?? `${job.name.replace("_", "-")}-${accountId}-adhoc`;
        return runAccountSync(job.name, jobId, accountId, job.attemptsMade + 1);
      }

      default:
        throw new Error(`unknown ingest job "${job.name}" (${job.id})`);
    }
  };
}
