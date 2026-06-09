import { getDb } from "../../src/db";
import { latestRunPerJob, listRecentRuns } from "../../src/queries";
import { requireOwnerId } from "../../src/session";

export const dynamic = "force-dynamic";

// MC-107 run health: latest-per-job up top (the "did the Morning Brief go
// out?" answer), failures red with retry, recent history below.
export default async function RunsPage() {
  const ownerId = await requireOwnerId();
  const db = getDb();
  const [latest, recent] = await Promise.all([
    latestRunPerJob(db, ownerId),
    listRecentRuns(db, ownerId),
  ]);

  return (
    <div>
      <h1>Runs</h1>

      <h2>Latest by job</h2>
      {latest.length === 0 ? <p>No runs recorded yet.</p> : null}
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr>
            <th align="left">job</th>
            <th align="left">status</th>
            <th align="left">started</th>
            <th align="left">error</th>
            <th align="left"></th>
          </tr>
        </thead>
        <tbody>
          {latest.map((r) => (
            <tr key={r.id} style={r.status === "failed" ? { color: "crimson" } : undefined}>
              <td>
                <a href={`/runs/${r.id}`}>{r.jobName}</a>
              </td>
              <td>{r.status}</td>
              <td>
                <small>{r.startedAt.toISOString()}</small>
              </td>
              <td>
                <small>{r.error ?? ""}</small>
              </td>
              <td>
                {r.status === "failed" ? (
                  <form action={`/api/runs/${r.id}/retry`} method="post" style={{ margin: 0 }}>
                    <button type="submit">Retry</button>
                  </form>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Recent runs</h2>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr>
            <th align="left">job</th>
            <th align="left">status</th>
            <th align="left">started</th>
            <th align="left">attempt</th>
          </tr>
        </thead>
        <tbody>
          {recent.map((r) => (
            <tr key={r.id} style={r.status === "failed" ? { color: "crimson" } : undefined}>
              <td>
                <a href={`/runs/${r.id}`}>{r.jobName}</a>
                <br />
                <small>{r.jobId}</small>
              </td>
              <td>{r.status}</td>
              <td>
                <small>{r.startedAt.toISOString()}</small>
              </td>
              <td>{r.attempt}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
