import { requireOwnerId } from "../../src/session";
import CaptureChat from "./capture-chat";

export default async function CapturePage() {
  await requireOwnerId();
  return (
    <div>
      <h1>Capture</h1>
      <CaptureChat />
    </div>
  );
}
