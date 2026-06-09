import { describe, expect, it } from "vitest";
import { CORE_PACKAGE } from "@mission-control/core";

describe("workspace wiring", () => {
  it("worker resolves cross-workspace imports", () => {
    expect(CORE_PACKAGE).toBe("@mission-control/core");
  });
});
