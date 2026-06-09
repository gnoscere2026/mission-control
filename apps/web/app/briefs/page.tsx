import { getDb } from "../../src/db";
import { listBriefs } from "../../src/queries";
import { requireOwnerId } from "../../src/session";

export default async function BriefsPage() {
  const ownerId = await requireOwnerId();
  const rows = await listBriefs(getDb(), ownerId);
  return (
    <div>
      <h1>Briefs</h1>
      {rows.length === 0 ? <p>No briefs yet — the 7 AM job (or a manual trigger) creates the first one.</p> : null}
      <ul>
        {rows.map((b) => (
          <li key={b.id} style={{ marginBottom: 8 }}>
            <a href={`/briefs/${b.id}`}>
              {b.kind} — {b.dedupeKey}
            </a>{" "}
            <small>
              generated {b.generatedAt.toISOString()}
              {b.emailedAt ? " · emailed" : ""}
              {b.pushedAt ? " · pushed" : ""}
              {b.openedAt ? " · opened" : ""}
            </small>
          </li>
        ))}
      </ul>
    </div>
  );
}
