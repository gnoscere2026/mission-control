"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface Message {
  id: string;
  text: string;
  occurredAt: string;
}
interface Candidate {
  id: string;
  episodeId: string | null;
  description: string;
  direction: string;
  status: string;
  confidence: number | null;
  dueDate: string | null;
  personName: string | null;
}

const POLL_MS = 4000;

// MC-108 chat surface: thread of captures with extracted candidates inline.
// Polling keeps it simple — extraction lands within seconds via the worker.
export default function CaptureChat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pinned, setPinned] = useState<Set<string>>(new Set());
  const bottomRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/capture/feed");
      if (!res.ok) return;
      const data = (await res.json()) as { messages: Message[]; candidates: Candidate[] };
      setMessages(data.messages);
      setCandidates(data.candidates);
    } catch {
      // transient polling failure — next tick retries
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  async function send() {
    const trimmed = text.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    const res = await fetch("/api/capture", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: trimmed }),
    });
    setBusy(false);
    if (!res.ok) {
      setError(await res.text());
      return;
    }
    setText("");
    await refresh();
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }

  async function pin(m: Message) {
    const res = await fetch("/api/memories", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: m.text, sourceEpisodeId: m.id }),
    });
    if (res.ok) setPinned((p) => new Set(p).add(m.id));
  }

  async function disposition(id: string, kind: "confirm" | "reject") {
    const res = await fetch(`/api/commitments/${id}/${kind}`, { method: "POST" });
    if (res.ok) await refresh();
  }

  const byEpisode = new Map<string, Candidate[]>();
  for (const c of candidates) {
    if (!c.episodeId) continue;
    byEpisode.set(c.episodeId, [...(byEpisode.get(c.episodeId) ?? []), c]);
  }

  return (
    <div>
      <div style={{ display: "grid", gap: 8 }}>
        {messages.length === 0 ? (
          <p>
            Type anything worth remembering — “told Sara I’d send the contract Friday” becomes a
            ledger candidate.
          </p>
        ) : null}
        {messages.map((m) => (
          <div key={m.id}>
            <div style={{ background: "#f3f4f6", borderRadius: 8, padding: "8px 12px" }}>
              {m.text}
              <div style={{ fontSize: 11, color: "#777", display: "flex", alignItems: "center", gap: 8 }}>
                {new Date(m.occurredAt).toLocaleString()}
                <button
                  onClick={() => void pin(m)}
                  disabled={pinned.has(m.id)}
                  style={{ marginLeft: 8, fontSize: 11 }}
                  title="Pin to memory"
                >
                  {pinned.has(m.id) ? "📌 pinned" : "📌 pin"}
                </button>
              </div>
            </div>
            {(byEpisode.get(m.id) ?? []).map((c) => (
              <div
                key={c.id}
                style={{
                  border: "1px solid #ddd",
                  borderLeft: "4px solid #6366f1",
                  borderRadius: 8,
                  padding: "8px 12px",
                  margin: "6px 0 6px 24px",
                  fontSize: 14,
                }}
              >
                <div>
                  <strong>{c.description}</strong>
                </div>
                <div style={{ color: "#444" }}>
                  {c.direction === "owed_by_me" ? "I owe" : "Owed to me"}
                  {c.personName ? ` · ${c.personName}` : ""}
                  {c.dueDate ? ` · due ${c.dueDate}` : ""}
                </div>
                {c.status === "candidate" ? (
                  <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                    <button onClick={() => void disposition(c.id, "confirm")}>✓ Confirm</button>
                    <button onClick={() => void disposition(c.id, "reject")}>✕ Reject</button>
                  </div>
                ) : (
                  <div style={{ marginTop: 4, color: c.status === "open" ? "green" : "#999" }}>
                    {c.status === "open" ? "✓ in ledger" : c.status}
                  </div>
                )}
              </div>
            ))}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 16, position: "sticky", bottom: 8 }}>
        <input
          style={{ flex: 1, padding: 8 }}
          value={text}
          placeholder="capture something…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button disabled={busy || !text.trim()} onClick={() => void send()}>
          Send
        </button>
      </div>
      {error ? <p style={{ color: "crimson" }}>{error}</p> : null}
    </div>
  );
}
