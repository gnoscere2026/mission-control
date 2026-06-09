import { describe, expect, it } from "vitest";
import { parseSubscription } from "./push";

const valid = {
  endpoint: "https://web.push.apple.com/abc123",
  keys: { p256dh: "key-material", auth: "auth-material" },
};

describe("parseSubscription", () => {
  it("accepts a browser PushSubscription JSON shape", () => {
    expect(parseSubscription(valid)).toEqual(valid);
  });
  it("rejects non-https endpoints", () => {
    expect(parseSubscription({ ...valid, endpoint: "http://evil.example" })).toBeNull();
  });
  it("rejects missing or empty keys", () => {
    expect(parseSubscription({ endpoint: valid.endpoint })).toBeNull();
    expect(parseSubscription({ endpoint: valid.endpoint, keys: { p256dh: "", auth: "x" } })).toBeNull();
    expect(parseSubscription({ endpoint: valid.endpoint, keys: { p256dh: "x" } })).toBeNull();
  });
  it("rejects non-objects", () => {
    expect(parseSubscription(null)).toBeNull();
    expect(parseSubscription("string")).toBeNull();
  });
});
