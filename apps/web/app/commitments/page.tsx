import { listLedger, type LedgerView } from "@mission-control/core";
import { getDb } from "../../src/db";
import { requireOwnerId } from "../../src/session";

export const dynamic = "force-dynamic";

const VIEWS: { key: LedgerView; label: string }[] = [
  { key: "open", label: "Open" },
  { key: "owed_to_me", label: "Owed to me" },
  { key: "snoozed", label: "Snoozed" },
];

// Commitment ledger (MC-105): open / owed-to-me / snoozed views + manual add.
export default async function CommitmentsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const ownerId = await requireOwnerId();
  const { view: rawView } = await searchParams;
  const view: LedgerView = VIEWS.some((v) => v.key === rawView) ? (rawView as LedgerView) : "open";
  const rows = await listLedger(getDb(), ownerId, view);

  return (
    <div>
      <h1>Commitments</h1>
      <p>
        {VIEWS.map((v) => (
          <a
            key={v.key}
            href={`/commitments?view=${v.key}`}
            style={{ marginRight: 12, fontWeight: v.key === view ? 700 : 400 }}
          >
            {v.label}
          </a>
        ))}
      </p>

      {rows.length === 0 ? <p>Nothing here.</p> : null}
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr>
            <th align="left">what</th>
            <th align="left">who</th>
            <th align="left">due</th>
            <th align="left">{view === "snoozed" ? "wakes" : "since"}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>
                {r.direction === "owed_by_me" ? "→ " : "← "}
                {r.description}
              </td>
              <td>{r.personName ?? ""}</td>
              <td>{r.dueDate ?? ""}</td>
              <td>
                <small>
                  {view === "snoozed"
                    ? (r.snoozedUntil?.toISOString().slice(0, 10) ?? "")
                    : r.createdAt.toISOString().slice(0, 10)}
                </small>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Add manually</h2>
      <form action="/api/commitments" method="post" style={{ display: "grid", gap: 8, maxWidth: 400 }}>
        <input name="description" placeholder="what was promised" required />
        <select name="direction" defaultValue="owed_by_me">
          <option value="owed_by_me">I owe</option>
          <option value="owed_to_me">Owed to me</option>
        </select>
        <input name="counterparty" placeholder="who (name or email, optional)" />
        <input name="dueDate" type="date" />
        <button type="submit">Add to ledger</button>
      </form>
    </div>
  );
}
