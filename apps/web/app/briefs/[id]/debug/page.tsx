import { notFound } from "next/navigation";
import type { MorningPacket } from "@mission-control/core";
import { getDb } from "../../../../src/db";
import { getBrief, getContextPacket, listCommitmentSources } from "../../../../src/queries";
import { requireOwnerId } from "../../../../src/session";

// MC-203 exit criterion 3: walk brief → packet → source rows.
export default async function BriefDebugPage({ params }: { params: Promise<{ id: string }> }) {
  const ownerId = await requireOwnerId();
  const { id } = await params;
  const db = getDb();
  const brief = await getBrief(db, ownerId, id);
  if (!brief) notFound();
  const packetRow = await getContextPacket(db, ownerId, brief.contextPacketId);
  const packet = packetRow?.content as MorningPacket | undefined;
  const sources = packet
    ? await listCommitmentSources(db, ownerId, packet.commitments.map((c) => c.id))
    : [];

  return (
    <div>
      <h1>Brief debug</h1>
      <p>
        <a href={`/briefs/${id}`}>← back to brief</a> · packet {brief.contextPacketId} · run{" "}
        {brief.cadenceRunId ? <a href={`/runs/${brief.cadenceRunId}`}>{brief.cadenceRunId}</a> : "—"}
      </p>

      <h2>Commitment sources</h2>
      {sources.length === 0 ? <p>No packet commitments.</p> : null}
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr><th align="left">commitment</th><th align="left">source</th><th align="left">excerpt</th></tr>
        </thead>
        <tbody>
          {sources.map((s) => (
            <tr key={s.id}>
              <td>{s.description}</td>
              <td><small>{s.sourceType}{s.episodeSummary ? ` · ${s.episodeSummary}` : ""}</small></td>
              <td><small>{s.sourceExcerpt ?? "—"}</small></td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Context packet</h2>
      <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, background: "#f6f6f6", padding: 12 }}>
        {JSON.stringify(packet ?? packetRow?.content, null, 2)}
      </pre>
    </div>
  );
}
