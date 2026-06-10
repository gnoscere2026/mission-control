import { requireOwnerId } from "../../src/session";
import GoogleSettings from "./google-settings";
import PushSettings from "./push-settings";

export default async function SettingsPage() {
  const ownerId = await requireOwnerId();
  return (
    <div>
      <h1>Settings</h1>
      <h2>Push notifications</h2>
      <PushSettings vapidPublicKey={process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? ""} />
      <h2>Google</h2>
      <GoogleSettings ownerId={ownerId} />
    </div>
  );
}
