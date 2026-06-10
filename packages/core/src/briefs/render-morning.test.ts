import { describe, expect, it } from "vitest";
import { renderMorningBriefMd } from "./render-morning";

const full = {
  headline: "Tight morning: contract due today, standup at 9:30.",
  top_commitments: [
    { commitment_id: "c1", description: "send Sara the contract", due_date: "2026-06-09", why_now: "due today" },
    { commitment_id: null, description: "review Q3 plan", due_date: null, why_now: null },
  ],
  schedule: [
    { time: "09:30", title: "Standup", prep_pointer: "skim yesterday's capture notes" },
    { time: "14:00", title: "1:1 with Dana", prep_pointer: null },
  ],
  waiting_on: [
    { commitment_id: "c2", description: "revised deck", counterparty: "Sara", nudge_draft: "Hi Sara — any update on the revised deck?" },
  ],
  slipped: [{ commitment_id: "c3", description: "intro Dana to Priya", due_date: "2026-06-05" }],
};

describe("renderMorningBriefMd", () => {
  it("renders all sections", () => {
    expect(renderMorningBriefMd(full, "2026-06-09")).toMatchSnapshot();
  });
  it("omits empty sections", () => {
    expect(
      renderMorningBriefMd(
        { headline: "Quiet day.", top_commitments: [], schedule: [], waiting_on: [], slipped: [] },
        "2026-06-09",
      ),
    ).toMatchSnapshot();
  });
});
