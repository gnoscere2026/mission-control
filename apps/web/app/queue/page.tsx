import { listCandidates } from "@mission-control/core";
import { getDb } from "../../src/db";
import { requireOwnerId } from "../../src/session";
import CandidateCard from "./candidate-card";

export const dynamic = "force-dynamic";

// Confirmation queue (MC-105): candidates newest-first, two taps max.
export default async function QueuePage() {
  const ownerId = await requireOwnerId();
  const candidates = await listCandidates(getDb(), ownerId);

  return (
    <div>
      <h1>Queue</h1>
      {candidates.length === 0 ? <p>No candidates waiting. ✨</p> : null}
      {candidates.map((c) => (
        <CandidateCard
          key={c.id}
          id={c.id}
          description={c.description}
          direction={c.direction}
          confidence={c.confidence}
          dueDate={c.dueDate}
          sourceType={c.sourceType}
          sourceExcerpt={c.sourceExcerpt}
          personName={c.personName}
        />
      ))}
    </div>
  );
}
