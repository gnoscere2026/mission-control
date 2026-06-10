"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export interface CandidateCardProps {
  id: string;
  description: string;
  direction: string;
  confidence: number | null;
  dueDate: string | null;
  sourceType: string;
  sourceExcerpt: string | null;
  personName: string | null;
}

// One-tap dispositions (MC-105): confirm / reject / snooze are single taps;
// edit opens an inline sheet, then one tap confirms.
export default function CandidateCard(c: CandidateCardProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [description, setDescription] = useState(c.description);
  const [direction, setDirection] = useState(c.direction);
  const [dueDate, setDueDate] = useState(c.dueDate ?? "");

  async function post(path: string, body?: unknown) {
    setBusy(true);
    setError(null);
    const res = await fetch(path, {
      method: "POST",
      ...(body !== undefined
        ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
        : {}),
    });
    setBusy(false);
    if (!res.ok) {
      setError(await res.text());
      return;
    }
    router.refresh();
  }

  return (
    <div style={{ border: "1px solid #ddd", borderRadius: 8, padding: 12, marginBottom: 12 }}>
      <div>
        <strong>{c.description}</strong>
      </div>
      <div style={{ fontSize: 14, color: "#444", margin: "4px 0" }}>
        {c.direction === "owed_by_me" ? "I owe" : "Owed to me"}
        {c.personName ? ` · ${c.personName}` : ""}
        {c.dueDate ? ` · due ${c.dueDate}` : ""}
        {typeof c.confidence === "number" ? ` · conf ${c.confidence.toFixed(2)}` : ""}
        {` · ${c.sourceType}`}
      </div>
      {c.sourceExcerpt ? (
        <details style={{ margin: "4px 0" }}>
          <summary style={{ cursor: "pointer", fontSize: 13 }}>source</summary>
          <blockquote style={{ margin: "4px 0", fontSize: 13, color: "#555" }}>
            {c.sourceExcerpt}
          </blockquote>
        </details>
      ) : null}

      {!editing ? (
        <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
          <button disabled={busy} onClick={() => post(`/api/commitments/${c.id}/confirm`)}>
            ✓ Confirm
          </button>
          <button disabled={busy} onClick={() => post(`/api/commitments/${c.id}/reject`)}>
            ✕ Reject
          </button>
          <button disabled={busy} onClick={() => post(`/api/commitments/${c.id}/snooze`, { days: 7 })}>
            ⏰ Snooze 1w
          </button>
          <button disabled={busy} onClick={() => setEditing(true)}>
            ✎ Edit
          </button>
        </div>
      ) : (
        <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
          <input value={description} onChange={(e) => setDescription(e.target.value)} />
          <select value={direction} onChange={(e) => setDirection(e.target.value)}>
            <option value="owed_by_me">I owe</option>
            <option value="owed_to_me">Owed to me</option>
          </select>
          <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          <div style={{ display: "flex", gap: 8 }}>
            <button
              disabled={busy}
              onClick={() => post(`/api/commitments/${c.id}/edit`, { description, direction, dueDate })}
            >
              ✓ Confirm edited
            </button>
            <button disabled={busy} onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {error ? <p style={{ color: "crimson", fontSize: 13 }}>{error}</p> : null}
    </div>
  );
}
