import { notFound } from "next/navigation";
import type { MorningBriefOutputT } from "@mission-control/core";
import { appendUserAction, markBriefOpened, MorningBriefOutput } from "@mission-control/core";
import { getDb } from "../../../src/db";
import { getBrief } from "../../../src/queries";
import { requireOwnerId } from "../../../src/session";

export const dynamic = "force-dynamic";

export default async function BriefReaderPage({ params }: { params: Promise<{ id: string }> }) {
  const ownerId = await requireOwnerId();
  const { id } = await params;
  const db = getDb();
  const brief = await getBrief(db, ownerId, id);
  if (!brief) notFound();

  // opened_at transitions once (graduation-gate metric 1); the user_action rides
  // the same first-open guard so it's exactly-once too.
  const firstOpen = await markBriefOpened(db, ownerId, id);
  if (firstOpen) {
    await appendUserAction(db, { ownerId, action: "brief_opened", entityType: "brief", entityId: id });
  }

  const parsed = brief.kind === "morning" ? MorningBriefOutput.safeParse(brief.contentJson) : null;

  return (
    <article>
      <p>
        <small>
          {brief.kind} · {brief.dedupeKey} · generated {brief.generatedAt.toISOString()} ·{" "}
          <a href={`/briefs/${id}/debug`}>why did you say this?</a>
        </small>
      </p>
      {parsed?.success ? (
        <MorningBriefView content={parsed.data} />
      ) : (
        <div style={{ whiteSpace: "pre-wrap" }}>{brief.contentMd}</div>
      )}
    </article>
  );
}

function MorningBriefView({ content }: { content: MorningBriefOutputT }) {
  return (
    <div>
      <p style={{ fontSize: 18 }}>{content.headline}</p>
      {content.schedule.length > 0 && (
        <section>
          <h2>Today</h2>
          <ul>
            {content.schedule.map((s, i) => (
              <li key={i}>
                <strong>{s.time}</strong> {s.title}
                {s.prep_pointer ? <em> — {s.prep_pointer}</em> : null}
              </li>
            ))}
          </ul>
        </section>
      )}
      {content.top_commitments.length > 0 && (
        <section>
          <h2>Top commitments</h2>
          <ul>
            {content.top_commitments.map((c, i) => (
              <li key={i}>
                <a href="/commitments">{c.description}</a>
                {c.due_date ? ` (due ${c.due_date})` : ""}
                {c.why_now ? ` — ${c.why_now}` : ""}
              </li>
            ))}
          </ul>
        </section>
      )}
      {content.waiting_on.length > 0 && (
        <section>
          <h2>Waiting on</h2>
          <ul>
            {content.waiting_on.map((w, i) => (
              <li key={i}>
                {w.description}
                {w.counterparty ? ` — ${w.counterparty}` : ""}
                <blockquote style={{ margin: "4px 0 4px 12px", color: "#555" }}>
                  draft: {w.nudge_draft}
                </blockquote>
              </li>
            ))}
          </ul>
        </section>
      )}
      {content.slipped.length > 0 && (
        <section>
          <h2>Slipped</h2>
          <ul>
            {content.slipped.map((s, i) => (
              <li key={i}>
                {s.description}
                {s.due_date ? ` (was due ${s.due_date})` : ""}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
