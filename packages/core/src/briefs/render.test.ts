import { describe, expect, it } from "vitest";
import { renderBriefEmail } from "./render";

describe("renderBriefEmail", () => {
  it("renders the plain email mirror (snapshot)", () => {
    const rendered = renderBriefEmail({
      kind: "morning",
      dedupeKey: "morning:2026-06-09",
      contentMd: "# Good morning — Mission Control\n\nWalking-skeleton brief for **2026-06-09**.",
      generatedAt: new Date("2026-06-09T13:00:00Z"),
    });
    expect(rendered).toMatchSnapshot();
  });

  it("falls back to the raw kind for unknown artifact kinds (open domain)", () => {
    const { subject } = renderBriefEmail({
      kind: "experimental_kind",
      dedupeKey: "experimental_kind:x1",
      contentMd: "body",
      generatedAt: new Date("2026-06-09T13:00:00Z"),
    });
    expect(subject).toBe("Mission Control — experimental_kind (x1)");
  });
});
