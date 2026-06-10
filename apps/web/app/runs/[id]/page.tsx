import { getDb } from "../../../src/db";
import { getRun, listRunSteps } from "../../../src/queries";
import { requireOwnerId } from "../../../src/session";

// MC-107 step drill-down: one run, its meta, its steps with detail JSON.
export default async function RunDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const ownerId = await requireOwnerId();
  const { id } = await params;
  const db = getDb();
  const run = await getRun(db, ownerId, id);
  if (!run) return <p>Run not found.</p>;
  const steps = await listRunSteps(db, run.id);

  return (
    <div>
      <h1>
        {run.jobName} <small>({run.jobId})</small>
      </h1>
      <p style={run.status === "failed" ? { color: "crimson" } : undefined}>
        <strong>{run.status}</strong> · attempt {run.attempt} · started{" "}
        {run.startedAt.toISOString()}
        {run.finishedAt ? ` · finished ${run.finishedAt.toISOString()}` : null}
      </p>
      {run.error ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{run.error}</pre> : null}
      {run.meta ? <pre>{JSON.stringify(run.meta, null, 2)}</pre> : null}

      <h2>Steps</h2>
      {steps.length === 0 ? <p>No steps recorded.</p> : null}
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr>
            <th align="left">#</th>
            <th align="left">step</th>
            <th align="left">status</th>
            <th align="left">detail</th>
          </tr>
        </thead>
        <tbody>
          {steps.map((s) => (
            <tr key={s.id} style={s.status === "failed" ? { color: "crimson" } : undefined}>
              <td>{s.seq}</td>
              <td>{s.name}</td>
              <td>{s.status}</td>
              <td>
                <small>
                  <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>
                    {s.detail ? JSON.stringify(s.detail) : ""}
                  </pre>
                </small>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        <a href="/runs">← all runs</a>
      </p>
    </div>
  );
}
