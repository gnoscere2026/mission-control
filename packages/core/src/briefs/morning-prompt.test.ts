import { describe, expect, it } from "vitest";
import { resolveTask } from "@mission-control/llm";
import { MorningBriefOutput, morningBriefV1 } from "./morning_brief.v1";
import { ACTIVE_MORNING_BRIEF } from "./active";

describe("cos.morning_brief v1", () => {
  it("is registered on the top tier", () => {
    expect(resolveTask("cos.morning_brief")).toMatchObject({ tier: "top", model: "claude-opus-4-8" });
  });

  it("active version is v1 with a stable content hash", () => {
    expect(ACTIVE_MORNING_BRIEF.version).toBe("v1");
    expect(ACTIVE_MORNING_BRIEF.contentHash()).toBe(morningBriefV1.contentHash());
    expect(morningBriefV1.contentHash()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("schema accepts a well-formed brief and rejects a sectionless one", () => {
    expect(
      MorningBriefOutput.safeParse({
        headline: "Tight morning: two deadlines and a 9:30 standup.",
        top_commitments: [{ commitment_id: null, description: "send contract", due_date: "2026-06-09", why_now: "due today" }],
        schedule: [{ time: "09:30", title: "Standup", prep_pointer: null }],
        waiting_on: [{ commitment_id: null, description: "revised deck", counterparty: "Sara", nudge_draft: "Hi Sara — any update on the revised deck?" }],
        slipped: [],
      }).success,
    ).toBe(true);
    expect(MorningBriefOutput.safeParse({ headline: "" }).success).toBe(false);
  });

  it("renderPrompt includes the packet JSON and flags stale sync", () => {
    const packet = {
      task: "cos.morning_brief", date: "2026-06-09", timezone: "America/Denver",
      owner: { name: "Mark" }, schedule: [], commitments: [], memories: [], recentEpisodes: [],
      preferences: {}, instructions: { safety: "s", format: "f" },
      meta: { truncations: [], staleSync: true, tokenEstimate: 100 },
    };
    const prompt = morningBriefV1.renderPrompt(packet as never);
    expect(prompt).toContain("2026-06-09");
    expect(prompt).toContain("CONTEXT PACKET");
    expect(prompt).toMatch(/stale/i);
  });
});
