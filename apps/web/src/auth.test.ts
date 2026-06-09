import { describe, expect, it } from "vitest";
import { verifySecret } from "./auth";

describe("verifySecret", () => {
  it("accepts the exact secret", () => {
    expect(verifySecret("correct horse", "correct horse")).toBe(true);
  });
  it("rejects a wrong secret", () => {
    expect(verifySecret("wrong", "correct horse")).toBe(false);
  });
  it("rejects different-length candidates", () => {
    expect(verifySecret("correct hors", "correct horse")).toBe(false);
  });
  it("rejects when no expected secret is configured", () => {
    expect(verifySecret("anything", undefined)).toBe(false);
    expect(verifySecret("anything", "")).toBe(false);
  });
});
