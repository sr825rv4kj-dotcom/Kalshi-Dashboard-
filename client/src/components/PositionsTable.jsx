import React from "react";

/**
 * Open positions for the selected account. Rows come in one shape from both
 * exchanges: { venue, ticker, label, side, contracts, exposureDollars }.
 * The exchange is named on each row when both are shown together.
 */

function usd(n) {
  return n == null || !Number.isFinite(Number(n))
    ? "—"
    : Number(n).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

export default function PositionsTable({ positions, showVenue = false }) {
  if (!positions.length) return <div className="empty-state">No open positions.</div>;
  return (
    <table>
      <thead>
        <tr><th>Market</th><th>Side</th><th>Contracts</th><th>Exposure</th></tr>
      </thead>
      <tbody>
        {positions.map((p) => (
          <tr key={`${p.venue}-${p.ticker}`}>
            <td style={{ wordBreak: "break-word", textTransform: p.venue === "polymarket" ? "capitalize" : "none" }}>
              {showVenue && (
                <span className="kx-pill" style={{ marginRight: 6, textTransform: "none" }}>
                  {p.venue === "polymarket" ? "Poly" : "Kalshi"}
                </span>
              )}
              {p.label || p.ticker}
            </td>
            <td className={p.side === "NO" ? "neg" : "pos"}>{p.side}</td>
            <td>{p.contracts}</td>
            <td>{usd(p.exposureDollars)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
