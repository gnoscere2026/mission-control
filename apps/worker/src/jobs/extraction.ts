import { UnrecoverableError, type Processor } from "bullmq";
import {
  extractCommitmentsFromEpisode,
  withCadenceRun,
  type ExtractFromEpisodeArgs,
  type ExtractFromEpisodeResult,
} from "@mission-control/core";
import type { JobContext } from "./index";

export interface ExtractionDeps {
  extractImpl?: (
    db: JobContext["db"],
    args: ExtractFromEpisodeArgs,
  ) => Promise<ExtractFromEpisodeResult>;
}

// extract_commitments {episodeId}: jobId `extract-episode-<id>` makes
// re-enqueue a no-op; the extraction_hash unique index + episode guard make
// even a duplicate execution converge (invariant 6, two layers).
export function makeExtractionProcessor(ctx: JobContext, deps: ExtractionDeps = {}): Processor {
  const extractImpl = deps.extractImpl ?? extractCommitmentsFromEpisode;
  return async (job) => {
    if (job.name !== "extract_commitments") {
      throw new Error(`unknown extraction job "${job.name}" (${job.id})`);
    }
    const { episodeId, force } = job.data as { episodeId?: string; force?: boolean };
    if (!episodeId) throw new UnrecoverableError("extract_commitments job missing episodeId");
    const jobId = job.id ?? `extract-episode-${episodeId}`;

    return withCadenceRun(
      ctx.db,
      {
        ownerId: ctx.owner.id,
        jobName: "extract_commitments",
        jobId,
        attempt: job.attemptsMade + 1,
        meta: { episodeId },
      },
      async (runId) =>
        extractImpl(ctx.db, { ownerId: ctx.owner.id, episodeId, runId, force: force === true }),
    );
  };
}
