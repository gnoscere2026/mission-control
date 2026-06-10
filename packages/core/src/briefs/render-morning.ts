import type { MorningBriefOutputT } from "./morning_brief.v1";

// JSON→markdown for the reader fallback + email mirror (MC-203). The reader's
// primary path renders content_json structurally; this stays dependency-free.
export function renderMorningBriefMd(content: MorningBriefOutputT, date: string): string {
  const lines: string[] = [`# Morning Brief — ${date}`, "", content.headline, ""];

  if (content.schedule.length > 0) {
    lines.push("## Today");
    for (const s of content.schedule)
      lines.push(`- **${s.time}** ${s.title}${s.prep_pointer ? ` — ${s.prep_pointer}` : ""}`);
    lines.push("");
  }
  if (content.top_commitments.length > 0) {
    lines.push("## Top commitments");
    for (const c of content.top_commitments)
      lines.push(
        `- ${c.description}${c.due_date ? ` (due ${c.due_date})` : ""}${c.why_now ? ` — ${c.why_now}` : ""}`,
      );
    lines.push("");
  }
  if (content.waiting_on.length > 0) {
    lines.push("## Waiting on");
    for (const w of content.waiting_on) {
      lines.push(`- ${w.description}${w.counterparty ? ` — ${w.counterparty}` : ""}`);
      lines.push(`  > draft nudge: ${w.nudge_draft}`);
    }
    lines.push("");
  }
  if (content.slipped.length > 0) {
    lines.push("## Slipped");
    for (const s of content.slipped)
      lines.push(`- ${s.description}${s.due_date ? ` (was due ${s.due_date})` : ""}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}
