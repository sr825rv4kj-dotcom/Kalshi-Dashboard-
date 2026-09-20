import React, { useMemo, useState } from "react";

/**
 * Cumulative profit and loss, drawn from Kalshi's own settlement records.
 *
 * This file had been overwritten at some point with a copy of DiagnosticPanel,
 * so the dashboard was rendering the diagnostic twice and the P&L chart did
 * not exist at all. Rendering the built page is what surfaced it - a nested
 * panel where a chart should have been.
 *
 * The series matters more now than it used to: positions are held to
 * settlement, so settlements ARE the record of what the bot made rather than a
 * footnote to a stream of flips.
 */

const W = 640;
const H = 190;
const PAD = { top: 14, right: 10, bottom: 22, left: 10 };

function money(n) {
  const v = Number(n) || 0;
  const sign = v < 0 ? "-" : "";
  return `${sign}$${Math.abs(v).toFixed(2)}`;
}

export default function PnlChart({ series }) {
  const [hover, setHover] = useState(null);

  const points = useMemo(() => {
    const rows = Array.isArray(series) ? series.filter((s) => Number.isFinite(Number(s.cumulativePnl))) : [];
    if (!rows.length) return null;

    const values = rows.map((r) => Number(r.cumulativePnl));
    // Always include zero, so a line that is entirely negative still reads as
    // below the break-even axis rather than floating in the middle.
    const lo = Math.min(0, ...values);
    const hi = Math.max(0, ...values);
    const span = hi - lo || 1;

    const innerW = W - PAD.left - PAD.right;
    const innerH = H - PAD.top - PAD.bottom;
    const x = (i) => PAD.left + (rows.length === 1 ? innerW / 2 : (i / (rows.length - 1)) * innerW);
    const y = (v) => PAD.top + innerH - ((v - lo) / span) * innerH;

    return {
      rows,
      coords: rows.map((r, i) => ({ x: x(i), y: y(Number(r.cumulativePnl)), row: r })),
      zeroY: y(0),
      last: values[values.length - 1],
      lo, hi,
    };
  }, [series]);

  if (!points) {
    return (
      <div className="empty-state">
        No settled trades yet. Positions are held to settlement, so this fills in
        as games finish.
      </div>
    );
  }

  const { coords, zeroY, last } = points;
  const up = last >= 0;
  const stroke = up ? "var(--green)" : "var(--red)";
  const gradId = up ? "pnlUp" : "pnlDown";

  const line = coords.map((c, i) => `${i ? "L" : "M"}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");
  const area =
    `${line} L${coords[coords.length - 1].x.toFixed(1)},${zeroY.toFixed(1)} ` +
    `L${coords[0].x.toFixed(1)},${zeroY.toFixed(1)} Z`;

  return (
    <div>
      <div className="pnl-headline">
        <span className={`pnl-total ${up ? "pos" : "neg"}`}>{money(last)}</span>
        <span className="pnl-caption">{coords.length} settled {coords.length === 1 ? "trade" : "trades"}</span>
      </div>

      <svg
        className="pnl-svg"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Cumulative profit and loss, currently ${money(last)}`}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id="pnlUp" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--green)" stopOpacity="0.34" />
            <stop offset="100%" stopColor="var(--green)" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="pnlDown" x1="0" y1="1" x2="0" y2="0">
            <stop offset="0%" stopColor="var(--red)" stopOpacity="0.34" />
            <stop offset="100%" stopColor="var(--red)" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* break-even */}
        <line
          x1={PAD.left} y1={zeroY} x2={W - PAD.right} y2={zeroY}
          stroke="var(--label-tertiary)" strokeWidth="1" strokeDasharray="3 4" vectorEffect="non-scaling-stroke"
        />

        <path d={area} fill={`url(#${gradId})`} />
        <path
          d={line} fill="none" stroke={stroke} strokeWidth="2"
          strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke"
        />

        {coords.map((c, i) => (
          <circle
            key={i} cx={c.x} cy={c.y} r={hover === i ? 5 : 3}
            fill={stroke} stroke="var(--bg)" strokeWidth="1.5" vectorEffect="non-scaling-stroke"
            onMouseEnter={() => setHover(i)}
            onClick={() => setHover(hover === i ? null : i)}
            style={{ cursor: "pointer" }}
          />
        ))}
      </svg>

      {hover != null && coords[hover] && (
        <div className="pnl-tip">
          <strong>{coords[hover].row.ticker}</strong>
          <span className={Number(coords[hover].row.pnl) >= 0 ? "pos" : "neg"}>
            {money(coords[hover].row.pnl)}
          </span>
          <span className="muted">
            running {money(coords[hover].row.cumulativePnl)}
            {coords[hover].row.date
              ? ` · ${new Date(coords[hover].row.date).toLocaleDateString([], { month: "short", day: "numeric" })}`
              : ""}
          </span>
        </div>
      )}
    </div>
  );
}
