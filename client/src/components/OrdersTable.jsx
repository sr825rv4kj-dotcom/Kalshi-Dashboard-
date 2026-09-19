import React, { useState } from "react";

/**
 * Kalshi's order history carries only tickers - no team names, no scores. So
 * this decodes the ticker itself: KXMLBGAME-26SEP18ATLPHI-PHI gives the sport,
 * the date, the matchup and which side was bought. Raw tickers move behind a
 * collapsible row rather than being the headline.
 */
const SERIES_META = {
  KXNFLGAME: { emoji: "🏈", label: "NFL" },
  KXNCAAFGAME: { emoji: "🏈", label: "NCAA Football" },
  KXNBAGAME: { emoji: "🏀", label: "NBA" },
  KXNCAABGAME: { emoji: "🏀", label: "NCAA Basketball" },
  KXWNBAGAME: { emoji: "🏀", label: "WNBA" },
  KXMLBGAME: { emoji: "⚾", label: "MLB" },
  KXNHLGAME: { emoji: "🏒", label: "NHL" },
  KXATPMATCH: { emoji: "🎾", label: "ATP Tennis" },
  KXWTAMATCH: { emoji: "🎾", label: "WTA Tennis" },
  KXITFMATCH: { emoji: "🎾", label: "ITF Tennis" },
  KXITFWMATCH: { emoji: "🎾", label: "ITF Tennis" },
  KXCS2GAME: { emoji: "🎮", label: "Counter-Strike" },
  KXLOLGAME: { emoji: "🎮", label: "League of Legends" },
  KXUFCFIGHT: { emoji: "🥊", label: "UFC" },
  KXNASCAR: { emoji: "🏁", label: "NASCAR" },
  KXPGA: { emoji: "⛳", label: "PGA" },
};

function colorFor(text) {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) % 360;
  return [`hsl(${h} 60% 42%)`, `hsl(${(h + 45) % 360} 58% 62%)`];
}

/** KXMLBGAME-26SEP18ATLPHI-PHI -> series, matchup code, side code. */
function decode(ticker) {
  const parts = String(ticker || "").split("-");
  const series = parts[0] || "";
  const middle = parts[1] || "";
  const side = parts[2] || "";

  const meta = SERIES_META[series] || { emoji: "🏆", label: series.replace(/^KX/, "") || "Market" };

  // The middle segment is a date stamp followed by team codes: 26SEP18ATLPHI.
  const m = middle.match(/^(\d{2}[A-Z]{3}\d{2})(.*)$/);
  const matchup = m ? m[2] : middle;

  return { series, meta, matchup, side };
}

export default function OrdersTable({ orders }) {
  const [showRaw, setShowRaw] = useState(false);

  if (!orders || orders.length === 0) {
    return <div className="empty-state">No recent orders.</div>;
  }

  return (
    <div>
      {orders.map((o, i) => {
        const { meta, matchup, side } = decode(o.ticker);
        const [primary, secondary] = colorFor(side || matchup || String(o.ticker));
        const isBuy = String(o.action || "").toLowerCase() === "buy";

        return (
                   <div key={o.orderId || `${o.ticker}-${i}`} className="order-row">
            <div
              className="team-chip-badge order-badge"
              style={{ background: primary, borderColor: secondary, color: secondary }}
            >
              <span className="team-chip-emoji">{meta.emoji}</span>
            </div>

            <div className="order-body">
              <div className="order-title">
                {side ? `${side} · ` : ""}{matchup || "—"}
              </div>
                           <div className="order-sub">
                {meta.label}
                {o.createdTime ? ` · ${new Date(o.createdTime).toLocaleString(undefined, {
                  month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
                })}` : ""}
                {o.priceCents != null ? ` · ${o.priceCents}c` : ""}
                {o.count != null ? ` · ${o.count}x` : ""}
              </div>

            <div className="order-right">
              <div className={isBuy ? "pos" : "neg"}>
                {isBuy ? "Buy" : "Sell"} {o.side || ""}
              </div>
              <div className="muted order-status">{o.status || ""}</div>
            </div>
          </div>
        );
      })}

      <button type="button" className="ledger-toggle" onClick={() => setShowRaw((v) => !v)}>
        {showRaw ? "Hide tickers" : "Show tickers"}
      </button>

      {showRaw && (
        <div className="ledger-detail">
          {orders.map((o, i) => (
            <div key={`raw-${i}`} className="trade-row">
              <span className="mono">{o.ticker}</span>
              <span className="muted">{o.status}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
