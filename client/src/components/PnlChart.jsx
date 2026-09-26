import React, { useMemo } from "react";
import ScrubChart from "./ScrubChart.jsx";
import { teamIdentity } from "../teamIdentity.js";

/**
 * Cumulative profit and loss - every closed bot trade, net of fees, from the
 * bot's own trade ledger (/api/pnl-history). Drag across it to read each
 * trade: game, date and time, what it made or lost, and the running total.
 */

function money(n) {
  const v = Number(n) || 0;
  return `${v < 0 ? "-" : ""}$${Math.abs(v).toFixed(2)}`;
}

/** Opponent code from the ticker: KX...-26SEP19MONTORST-MONT -> ORST */
function opponentFrom(ticker) {
  const parts = String(ticker || "").split("-");
  const side = parts[2] || "";
  const middle = (parts[1] || "").replace(/^\d{2}[A-Z]{3}\d{2}(\d{4})?/, "");
  if (!side || !middle) return null;
  if (middle.startsWith(side)) return middle.slice(side.length) || null;
  if (middle.endsWith(side)) return middle.slice(0, -side.length) || null;
  return null;
}

export default function PnlChart({ series }) {
  const points = useMemo(() => (Array.isArray(series) ? series : [])
    .filter((s) => Number.isFinite(Number(s.cumulativePnl)))
    .map((s) => {
      const name = s.team ? teamIdentity(s.team).name : s.ticker;
      const opp = opponentFrom(s.ticker);
      return {
        value: Number(s.cumulativePnl),
        change: Number(s.pnl),
        label: `${name}${opp ? ` vs ${opp}` : ""}`,
        sub: s.exit ? String(s.exit).replace(/-/g, " ") : s.ticker,
        date: s.date,
      };
    }), [series]);

  if (!points.length) {
    return <div className="empty-state">No closed trades yet - this fills in as games finish.</div>;
  }

  const last = points[points.length - 1].value;
  return (
    <div>
      <div className="pnl-headline">
        <span className={`pnl-total ${last >= 0 ? "pos" : "neg"}`}>{money(last)}</span>
        <span className="pnl-caption">{points.length} closed {points.length === 1 ? "trade" : "trades"} · net of fees</span>
      </div>
      <ScrubChart points={points} />
    </div>
  );
}
