import webpush from "web-push";
import { and, eq, isNull } from "drizzle-orm";
import { pushSubscriptions, type Db } from "@mission-control/db";

export interface PushMessage {
  title: string;
  body: string;
  url: string;
}

export interface WebPushClient {
  send(sub: { endpoint: string; p256dh: string; auth: string }, payload: string): Promise<void>;
}

// Lazily created inside the notify job — missing VAPID config degrades that
// run's push step, it never crashes the worker (push is best-effort on iOS,
// the email mirror is the contract — ARCHITECTURE §2.4).
export function createWebPushClient(): WebPushClient {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT;
  if (!publicKey || !privateKey || !subject) {
    throw new Error("VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY/VAPID_SUBJECT not configured");
  }
  return {
    async send(sub, payload) {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload,
        { vapidDetails: { subject, publicKey, privateKey } },
      );
    },
  };
}

export interface PushResult {
  attempted: number;
  sent: number;
  gone: number;
  errors: string[];
}

// MC-006 pruning contract: 404/410 increments failure_count and disables the
// subscription at 5; success resets the counter. Other errors are recorded but
// don't count toward pruning (transient push-service failures shouldn't kill
// a healthy subscription).
export async function sendPushToOwner(
  db: Db,
  ownerId: string,
  message: PushMessage,
  client: WebPushClient,
): Promise<PushResult> {
  const subs = await db
    .select()
    .from(pushSubscriptions)
    .where(and(eq(pushSubscriptions.ownerId, ownerId), isNull(pushSubscriptions.disabledAt)));

  const payload = JSON.stringify(message);
  let sent = 0;
  let gone = 0;
  const errors: string[] = [];

  for (const sub of subs) {
    try {
      await client.send({ endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth }, payload);
      sent++;
      await db
        .update(pushSubscriptions)
        .set({ lastSuccessAt: new Date(), failureCount: 0 })
        .where(eq(pushSubscriptions.id, sub.id));
    } catch (err) {
      const statusCode = (err as { statusCode?: number }).statusCode;
      if (statusCode === 404 || statusCode === 410) {
        gone++;
        const failureCount = sub.failureCount + 1;
        await db
          .update(pushSubscriptions)
          .set({ failureCount, ...(failureCount >= 5 ? { disabledAt: new Date() } : {}) })
          .where(eq(pushSubscriptions.id, sub.id));
      }
      errors.push(
        `${sub.endpoint.slice(0, 48)}…: ${(err as Error).message ?? String(err)} (status ${statusCode ?? "?"})`,
      );
    }
  }
  return { attempted: subs.length, sent, gone, errors };
}
