import { getDb } from "../../src/db";
import { listRecentRuns } from "../../src/queries";
import { requireOwnerId } from "../../src/session";

// Phase-0 run health: recent runs, failures red (BUILD-PLAN exit criterion 3).
// The full latest-per-job view + retry button is MC-107.
export default async function RunsPage() {
  const ownerId = await requireOwnerId();
  const runs = await listRecentRuns(getDb(), ownerId);
  return (
    <div>
      <h1>Runs</h1>
      {runs.length === 0 ? <p>No runs recorded yet.</p> : null}
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr>
            <th align="left">job</th>
            <th align="left">status</th>
            <th align="left">started</th>
            <th align="left">attempt</th>
            <th align="left">error</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id} style={r.status === "failed" ? { color: "crimson" } : undefined}>
              <td>
                {r.jobName}
                <br />
                <small>{r.jobId}</small>
              </td>
              <td>{r.status}</td>
              <td>
                <small>{r.startedAt.toISOString()}</small>
              </td>
              <td>{r.attempt}</td>
              <td>
                <small>{r.error ?? ""}</small>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
