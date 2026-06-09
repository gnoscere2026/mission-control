import { requireOwnerId } from "../../src/session";
import PushSettings from "./push-settings";

export default async function SettingsPage() {
  await requireOwnerId();
  return (
    <div>
      <h1>Settings</h1>
      <h2>Push notifications</h2>
      <PushSettings vapidPublicKey={process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? ""} />
      <h2>Google</h2>
      <p>Gmail / Calendar connect arrives in Phase 1 (MC-101).</p>
    </div>
  );
}
