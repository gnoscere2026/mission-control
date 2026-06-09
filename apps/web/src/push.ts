export interface SubscriptionPayload {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

// Browser PushSubscription.toJSON() shape; anything else is a 400.
export function parseSubscription(body: unknown): SubscriptionPayload | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.endpoint !== "string" || !b.endpoint.startsWith("https://")) return null;
  const keys = b.keys as Record<string, unknown> | undefined;
  if (!keys || typeof keys.p256dh !== "string" || typeof keys.auth !== "string") return null;
  if (keys.p256dh.length === 0 || keys.auth.length === 0) return null;
  return { endpoint: b.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}
