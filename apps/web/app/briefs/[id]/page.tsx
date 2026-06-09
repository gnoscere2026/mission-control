import { notFound } from "next/navigation";
import { getDb } from "../../../src/db";
import { getBrief } from "../../../src/queries";
import { requireOwnerId } from "../../../src/session";

export default async function BriefReaderPage({ params }: { params: Promise<{ id: string }> }) {
  const ownerId = await requireOwnerId();
  const { id } = await params;
  const brief = await getBrief(getDb(), ownerId, id);
  if (!brief) notFound();

  return (
    <article>
      <p>
        <small>
          {brief.kind} · {brief.dedupeKey} · generated {brief.generatedAt.toISOString()}
        </small>
      </p>
      {/* Phase 0: plain render of content_md; the structured reader is MC-203 */}
      <div style={{ whiteSpace: "pre-wrap" }}>{brief.contentMd}</div>
    </article>
  );
}
