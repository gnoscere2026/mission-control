import { requireOwnerId } from "../src/session";

export default async function HomePage() {
  await requireOwnerId();
  return (
    <div>
      <h1>Mission Control</h1>
      <p>Walking skeleton (Phase 0). The 7 AM hello brief lands under Briefs.</p>
      <ul>
        <li>
          <a href="/briefs">Briefs</a> — generated artifacts, newest first
        </li>
        <li>
          <a href="/runs">Runs</a> — job health; failures show red
        </li>
        <li>
          <a href="/settings">Settings</a> — push notifications, PWA install
        </li>
      </ul>
    </div>
  );
}
