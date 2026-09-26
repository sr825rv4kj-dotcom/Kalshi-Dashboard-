import React, { useMemo, useRef, useState } from "react";

/**
 * ScrubChart - a cumulative P&L line you can read with your finger.
 *
 * Drag (or hover) anywhere across the chart: a guide line snaps to the nearest
 * closed trade and a card shows the game, the date and time it closed, what
 * that trade made or lost, and the running total at that point. Built for a
 * phone: pointer events cover touch, mouse and pen, and `touch-action: pan-y`
 * keeps vertical page scrolling working while horizontal drags scrub.
 *
 * points: [{ value, change, label, sub, date }]
 *   value  running total after this trade (dollars)
 *   change this trade's own profit or loss (dollars)
 *   label  the game, e.g. "Dallas Stars vs SJ"
 *   sub    detail line, e.g. "3 @ 42c -> 100c - settled-win"
 *   date   ISO time the trade closed
 */

function money(n) {
  const v = Number(n) || 0;
  return `${v < 0 ? "-" : "+"}$${Math.abs(v).toFixed(2)}`;
}

function when(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export default function ScrubChart({ points, height = 190, compact = false }) {
  const [active, setActive] = useState(null);
  const svgRef = useRef(null);

  const W = compact ? 320 : 640;
  const H = height;
  const PAD = compact ? { top: 6, right: 6, bottom: 6, left: 6 } : { top: 14, right: 10, bottom: 14, left: 10 };

  const geo = useMemo(() => {
    const rows = (points || []).filter((p) => Number.isFinite(Number(p.value)));
    if (rows.length < 1) return null;
    // Start the line at zero so the first trade's own move is visible.
    const values = [0, ...rows.map((r) => Number(r.value))];
    const lo = Math.min(0, ...values);
    const hi = Math.max(0, ...values);
    const span = hi - lo || 1;
    const innerW = W - PAD.left - PAD.right;
    const innerH = H - PAD.top - PAD.bottom;
    const n = values.length;
    const x = (i) => PAD.left + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW);
    const y = (v) => PAD.top + innerH - ((v - lo) / span) * innerH;
    const coords = values.map((v, i) => ({ x: x(i), y: y(v), row: i === 0 ? null : rows[i - 1] }));
    return { coords, zeroY: y(0), last: values[values.length - 1] };
  }, [points, W, H, PAD.left, PAD.right, PAD.top, PAD.bottom]);

  if (!geo) return null;

  const { coords, zeroY, last } = geo;
  const up = last >= 0;
  const stroke = up ? "var(--green)" : "var(--red)";
  const line = coords.map((c, i) => `${i ? "L" : "M"}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");
  const area = `${line} L${coords[coords.length - 1].x.toFixed(1)},${zeroY.toFixed(1)} L${coords[0].x.toFixed(1)},${zeroY.toFixed(1)} Z`;
  const gid = `scrub-${compact ? "c" : "f"}-${up ? "u" : "d"}`;

  /** Nearest trade (never the zero anchor) to a screen x position. */
  const pick = (clientX) => {
    const el = svgRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (!r.width) return;
    const vx = ((clientX - r.left) / r.width) * W;
    let best = 1;
    let dist = Infinity;
    for (let i = 1; i < coords.length; i++) {
      const d = Math.abs(coords[i].x - vx);
      if (d < dist) { dist = d; best = i; }
    }
    setActive(best);
  };

  const a = active != null ? coords[active] : null;
  const row = a?.row;

  return (
    <div style={{ position: "relative", width: "100%" }}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        style={{ width: "100%", height: compact ? 56 : H, display: "block", touchAction: "pan-y", userSelect: "none", WebkitUserSelect: "none" }}
        role="img"
        aria-label={`Cumulative profit and loss, currently ${money(last)}`}
        onPointerDown={(e) => pick(e.clientX)}
        onPointerMove={(e) => { if (e.pointerType === "mouse" || e.buttons || e.pressure > 0) pick(e.clientX); }}
        onMouseMove={(e) => pick(e.clientX)}
        onTouchStart={(e) => e.touches[0] && pick(e.touches[0].clientX)}
        onTouchMove={(e) => e.touches[0] && pick(e.touches[0].clientX)}
      >
        <defs>
          <linearGradient id={gid} x1="0" y1={up ? "0" : "1"} x2="0" y2={up ? "1" : "0"}>
            <stop offset="0%" stopColor={stroke} stopOpacity="0.32" />
            <stop offset="100%" stopColor={stroke} stopOpacity="0" />
          </linearGradient>
        </defs>
        <line x1={PAD.left} y1={zeroY} x2={W - PAD.right} y2={zeroY}
          stroke="var(--label-tertiary)" strokeWidth="1" strokeDasharray="3 4" vectorEffect="non-scaling-stroke" />
        <path d={area} fill={`url(#${gid})`} />
        <path d={line} fill="none" stroke={stroke} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        {a && (
          <>
            <line x1={a.x} y1={PAD.top} x2={a.x} y2={H - PAD.bottom}
              stroke="var(--label-tertiary)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          </>
        )}
      </svg>
      {a && (
        // The marker is HTML, not SVG: the chart stretches to the screen width,
        // which would squash an SVG circle into an oval.
        <div style={{
          position: "absolute", left: `${(a.x / W) * 100}%`, top: (a.y / H) * (compact ? 56 : H),
          width: 11, height: 11, marginLeft: -5.5, marginTop: -5.5, borderRadius: "50%", pointerEvents: "none",
          background: Number(row?.change) >= 0 ? "var(--green)" : "var(--red)", border: "2px solid var(--bg)",
        }} />
      )}

      {row ? (
        <div style={{
          marginTop: 8, padding: "10px 12px", borderRadius: 12,
          background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.08)",
          fontSize: 14, lineHeight: 1.45,
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
            <strong style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textTransform: "capitalize" }}>{String(row.label).split(" vs ")[0]}{String(row.label).includes(" vs ") && <span style={{ textTransform: "none" }}>{" vs " + String(row.label).split(" vs ")[1]}</span>}</strong>
            <strong className={Number(row.change) >= 0 ? "pos" : "neg"} style={{ whiteSpace: "nowrap" }}>{money(row.change)}</strong>
          </div>
          <div className="muted" style={{ fontSize: 12.5 }}>{when(row.date)}</div>
          {row.sub && <div className="muted" style={{ fontSize: 12.5 }}>{row.sub}</div>}
          <div style={{ fontSize: 12.5 }}>
            Running total <span className={Number(row.value) >= 0 ? "pos" : "neg"}>{money(row.value)}</span>
            <span className="muted"> · trade {active} of {coords.length - 1}</span>
          </div>
        </div>
      ) : (
        !compact && <div className="muted" style={{ marginTop: 6, fontSize: 12.5 }}>Drag across the chart to see each trade.</div>
      )}
    </div>
  );
}
