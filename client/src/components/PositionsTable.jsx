import React from "react";
export default function PositionsTable({ positions }) {
  if (!positions.length) return <div className="empty-state">No open positions.</div>;
  return (
    <table>
      <thead><tr><th>Ticker</th><th>Side</th><th>Contracts</th><th>Exposure</th></tr></thead>
      <tbody>
        {positions.map((p) => (
          <tr key={p.ticker}>
            <td>{p.ticker}</td>
            <td className={p.position >= 0 ? "pos" : "neg"}>{p.position >= 0 ? "YES" : "NO"}</td>
            <td>{Math.abs(p.position)}</td>
            <td>{p.marketExposureDollars.toLocaleString("en-US", { style: "currency", currency: "USD" })}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
