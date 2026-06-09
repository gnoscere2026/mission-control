import { describe, expect, it } from "vitest";
import { DB_PACKAGE } from "./index";

describe("workspace wiring", () => {
  it("resolves the db workspace", () => {
    expect(DB_PACKAGE).toBe("@mission-control/db");
  });
});
