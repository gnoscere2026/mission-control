export interface RenderableBrief {
  kind: string;
  dedupeKey: string;
  contentMd: string;
  generatedAt: Date;
}

const KIND_TITLES: Record<string, string> = {
  morning: "Morning Brief",
  eod: "EOD Close",
  weekly: "Weekly Review",
  meeting_prep: "Prep Brief",
};

// The email mirror is a plain render of content_md (brief §2.1: ~20 lines of
// insurance, not a template system).
export function renderBriefEmail(brief: RenderableBrief): { subject: string; text: string } {
  const title = KIND_TITLES[brief.kind] ?? brief.kind;
  // dedupe key carries the natural date key ("morning:2026-06-09")
  const dateKey = brief.dedupeKey.split(":")[1] ?? "";
  const subject = `Mission Control — ${title}${dateKey ? ` (${dateKey})` : ""}`;
  return { subject, text: brief.contentMd };
}
