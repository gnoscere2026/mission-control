import { requireOwnerId } from "../../src/session";
import { getDb } from "../../src/db";
import { listPushSubscriptions } from "../../src/queries";
import GoogleSettings from "./google-settings";
import PushSettings from "./push-settings";

export default async function SettingsPage() {
  const ownerId = await requireOwnerId();
  const db = getDb();
  const subs = await listPushSubscriptions(db, ownerId);
  return (
    <div>
      <h1>Settings</h1>
      <h2>Push notifications</h2>
      <PushSettings vapidPublicKey={process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? ""} />
      <h3>Push delivery health</h3>
      {subs.length === 0 ? (
        <p>No devices subscribed.</p>
      ) : (
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr>
              <th align="left">device</th>
              <th align="left">status</th>
              <th align="left">last success</th>
            </tr>
          </thead>
          <tbody>
            {subs.map((s) => (
              <tr key={s.id} style={s.disabledAt ? { color: "crimson" } : undefined}>
                <td>
                  <small>{s.userAgent ?? s.endpoint.slice(0, 40)}</small>
                </td>
                <td>
                  {s.disabledAt
                    ? `push broken since ${s.disabledAt.toISOString().slice(0, 10)} — re-enable on the device`
                    : s.failureCount > 0
                      ? `flaky (${s.failureCount} recent failures)`
                      : "healthy"}
                </td>
                <td>
                  <small>{s.lastSuccessAt?.toISOString() ?? "never"}</small>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h2>Google</h2>
      <GoogleSettings ownerId={ownerId} />
    </div>
  );
}
