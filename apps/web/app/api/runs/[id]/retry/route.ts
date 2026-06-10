import { getDb } from "../../../../../src/db";
import { getQueue } from "../../../../../src/queues";
import { getRun } from "../../../../../src/queries";
import { getSession } from "../../../../../src/session";

// MC-107 manual retry. Retried jobs get a fresh `-r<epochSec>` jobId so a
// completed BullMQ job with the original id can't swallow the re-enqueue;
// convergence comes from the domain layer (upserts, dedupe keys, extraction
// hashes), not from jobId reuse.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session.ownerId) return new Response("Unauthorized", { status: 401 });

  const { id } = await params;
  const run = await getRun(getDb(), session.ownerId, id);
  if (!run) return new Response("Run not found", { status: 404 });

  const suffix = `r${Math.floor(Date.now() / 1000)}`;
  const meta = (run.meta ?? {}) as { accountId?: string; episodeId?: string };

  switch (run.jobName) {
    case "ingest_gmail":
    case "ingest_gcal": {
      if (!meta.accountId) return new Response("run meta has no accountId", { status: 400 });
      await getQueue("ingest").add(
        run.jobName,
        { accountId: meta.accountId },
        { jobId: `${run.jobName.replace("_", "-")}-${meta.accountId}-${suffix}` },
      );
      break;
    }
    case "extract_commitments": {
      if (!meta.episodeId) return new Response("run meta has no episodeId", { status: 400 });
      await getQueue("extraction").add(
        "extract_commitments",
        { episodeId: meta.episodeId },
        { jobId: `extract-episode-${meta.episodeId}-${suffix}` },
      );
      break;
    }
    case "morning_brief": {
      const date = run.jobId.match(/(\d{4}-\d{2}-\d{2})/)?.[1];
      if (!date) return new Response("cannot derive date from jobId", { status: 400 });
      await getQueue("briefs").add("morning_brief", { date }, { jobId: `morning-brief-${date}-${suffix}` });
      break;
    }
    case "notify": {
      const briefId = run.jobId.replace(/^notify-/, "").replace(/-r\d+$/, "");
      if (!briefId) return new Response("cannot derive briefId from jobId", { status: 400 });
      await getQueue("notify").add("deliver_brief", { briefId }, { jobId: `notify-${briefId}-${suffix}` });
      break;
    }
    default:
      return new Response(`no retry recipe for job "${run.jobName}"`, { status: 400 });
  }

  const base = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  return Response.redirect(`${base}/runs?retried=${run.jobName}`, 303);
}
