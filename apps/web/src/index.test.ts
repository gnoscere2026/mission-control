import { describe, expect, it } from "vitest";
import { DB_PACKAGE } from "@mission-control/db";

describe("workspace wiring", () => {
  it("web resolves cross-workspace imports", () => {
    expect(DB_PACKAGE).toBe("@mission-control/db");
  });
});
