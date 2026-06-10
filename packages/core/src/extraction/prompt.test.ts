import { describe, expect, it } from "vitest";
import { extractCommitmentsV1 } from "./extract_commitments.v1";
import { ACTIVE_EXTRACTION, EXTRACTION_VERSIONS } from "./active";

describe("extract_commitments v1 prompt module", () => {
  it("renderPrompt includes the weekday, owner identity, and headers", () => {
    const prompt = extractCommitmentsV1.renderPrompt({
      sourceType: "email",
      ownerName: "Mark",
      ownerEmails: ["mark@example.com"],
      from: "Dana <dana@acme.example>",
      to: "Mark <mark@example.com>",
      subject: "Re: deck",
      occurredAt: "2026-06-08T14:00:00.000Z",
      body: "I'll send it Thursday.",
    });
    expect(prompt).toContain("OCCURRED AT: 2026-06-08T14:00:00.000Z (Monday)");
    expect(prompt).toContain("OWNER: Mark <mark@example.com>");
    expect(prompt).toContain("FROM: Dana <dana@acme.example>");
    expect(prompt).toContain("BODY:\nI'll send it Thursday.");
  });

  it("contentHash is stable and version registry exposes v1 as active", () => {
    expect(extractCommitmentsV1.contentHash()).toBe(extractCommitmentsV1.contentHash());
    expect(ACTIVE_EXTRACTION.version).toBe("v1");
    expect(EXTRACTION_VERSIONS.v1).toBe(extractCommitmentsV1);
  });
});
