import { describe, expect, it } from "vitest";
import { DB_PACKAGE } from "@mission-control/db";
import { CORE_PACKAGE } from "./index";

describe("workspace wiring", () => {
  it("resolves the core workspace", () => {
    expect(CORE_PACKAGE).toBe("@mission-control/core");
  });
  it("resolves cross-workspace imports", () => {
    expect(DB_PACKAGE).toBe("@mission-control/db");
  });
});
