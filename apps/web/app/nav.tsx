import { anyLatestRunFailed } from "../src/queries";
import { getDb } from "../src/db";
import { getSession } from "../src/session";

// Server-rendered nav with the MC-107 failure badge. Session-less requests
// (login page) render the plain nav — no DB query.
export default async function Nav() {
  let failed = false;
  try {
    const session = await getSession();
    if (session.ownerId) failed = await anyLatestRunFailed(getDb(), session.ownerId);
  } catch {
    // missing SESSION_SECRET et al. shouldn't take down the shell
  }
  return (
    <nav style={{ display: "flex", gap: 16, paddingBottom: 12, borderBottom: "1px solid #ddd" }}>
      <a href="/">Home</a>
      <a href="/briefs">Briefs</a>
      <a href="/queue">Queue</a>
      <a href="/commitments">Commitments</a>
      <a href="/capture">Capture</a>
      <a href="/runs">
        Runs
        {failed ? (
          <span
            title="a job's latest run failed"
            style={{ color: "crimson", fontWeight: 700, marginLeft: 4 }}
          >
            ●
          </span>
        ) : null}
      </a>
      <a href="/settings">Settings</a>
    </nav>
  );
}
