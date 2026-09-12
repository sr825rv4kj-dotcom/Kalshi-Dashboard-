import React from "react";
function formatTimestamp(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
export default function OrdersTable({ orders }) {
  if (!orders.length) return <div className="empty-state">No recent orders.</div>;
  return (
    <table>
      <thead><tr><th>Timestamp</th><th>Ticker</th><th>Action</th><th>Price</th><th>Status</th></tr></thead>
      <tbody>
        {orders.map((o) => (
          <tr key={o.orderId}>
            <td className="muted" style={{ whiteSpace: "nowrap" }}>{formatTimestamp(o.createdTime)}</td>
            <td>{o.ticker}</td>
            <td className={o.action === "buy" ? "pos" : "neg"}>{o.action} {o.side}</td>
            <td>{o.priceCents != null ? `${o.priceCents}¢` : "—"}</td>
            <td className="muted">{o.status}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
