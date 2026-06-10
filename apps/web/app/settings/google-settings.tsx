import { listGoogleAccounts } from "@mission-control/core";
import { getDb } from "../../src/db";

// Server component: connected Google accounts with status; reauth_required
// renders the red banner + one-tap re-consent (MC-101 / R2).
export default async function GoogleSettings({ ownerId }: { ownerId: string }) {
  const accounts = await listGoogleAccounts(getDb(), ownerId);
  return (
    <div>
      {accounts.length === 0 ? <p>No Google account connected.</p> : null}
      {accounts.map((a) => (
        <div key={a.id} style={{ marginBottom: 8 }}>
          <strong>{a.email}</strong>{" "}
          {a.status === "reauth_required" ? (
            <span style={{ color: "crimson" }}>
              — re-connect needed (Google consent expired).{" "}
              <a href="/api/google/connect">Reconnect</a>
            </span>
          ) : (
            <span style={{ color: "green" }}>— {a.status}</span>
          )}
          <div>
            <small>
              gmail sync: {a.gmailLastSyncAt ? a.gmailLastSyncAt.toISOString() : "never"} · gcal
              sync: {a.gcalLastSyncAt ? a.gcalLastSyncAt.toISOString() : "never"}
            </small>
          </div>
          <form action="/api/google/disconnect" method="post">
            <input type="hidden" name="accountId" value={a.id} />
            <button type="submit">Disconnect</button>
          </form>
        </div>
      ))}
      <p>
        <a href="/api/google/connect">
          <button type="button">{accounts.length === 0 ? "Connect Google" : "Connect another account"}</button>
        </a>
      </p>
    </div>
  );
}
