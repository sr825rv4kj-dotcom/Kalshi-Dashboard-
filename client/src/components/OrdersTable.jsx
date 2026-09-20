import React from "react";
import { sportEmoji } from "../teamIdentity.js";

/**
 * Kalshi's raw order feed carries only tickers, so both sides of the game are
 * decoded from the ticker itself:
 *   KXNCAAFGAME-26SEP19PURUCLA-PUR
 *   series ......^ date ^ matchup ^ side
 * The matchup segment is the two team codes concatenated, and the side code is
 * one of them - stripping it leaves the opponent. Full names only exist for
 * trades the bot placed, which is what the Trade Log shows.
 */
const SERIES_META = {
  KXNFLGAME: { key: "americanfootball_nfl", label: "NFL" },
  KXNCAAFGAME: { key: "americanfootball_ncaaf", label: "NCAA Football" },
  KXNBAGAME: { key: "basketball_nba", label: "NBA" },
  KXNCAABGAME: { key: "basketball_ncaab", label: "NCAA Basketball" },
  KXWNBAGAME: { key: "basketball_wnba", label: "WNBA" },
  KXMLBGAME: { key: "baseball_mlb", label: "MLB" },
  KXNHLGAME: { key: "icehockey_nhl", label: "NHL" },
  KXATPMATCH: { key: "tennis", label: "ATP Tennis" },
  KXWTAMATCH: { key: "tennis", label: "WTA Tennis" },
  KXITFMATCH: { key: "tennis", label: "ITF Tennis" },
  KXITFWMATCH: { key: "tennis", label: "ITF Tennis" },
  KXCS2GAME: { key: "esports", label: "Counter-Strike" },
  KXLOLGAME: { key: "esports", label: "League of Legends" },
  KXUFCFIGHT: { key: "mma_mixed_martial_arts", label: "UFC" },
  KXNASCAR: { key: "motorsport_nascar", label: "NASCAR" },
  KXPGA: { key: "golf", label: "PGA" },
};

function decode(ticker) {
  const parts = String(ticker || "").split("-");
  const series = parts[0] || "";
  const middle = parts[1] || "";
  const side = parts[2] || "";
  const meta = SERIES_META[series] || { key: null, label: series.replace(/^KX/, "") || "Market" };

  // Strip the leading date stamp: 26SEP19PURUCLA -> PURUCLA
  const m = middle.match(/^(\d{2}[A-Z]{3}\d{2})(.*)$/);
  const matchup = m ? m[2] : middle;

  // The side code sits at one end of the matchup; whatever remains is the
  // opponent. Falls back to the raw matchup when it does not split cleanly.
  let held = side || null;
  let opponent = null;
  if (side && matchup.startsWith(side)) opponent = matchup.slice(side.length) || null;
  else if (side && matchup.endsWith(side)) opponent = matchup.slice(0, -side.length) || null;

  return { meta, matchup, side, held, opponent };
}

function when(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

function colorFor(text) {
  let h = 0;
  for (let i = 0; i < String(text).length; i++) h = (h * 31 + String(text).charCodeAt(i)) % 360;
  return [`hsl(${h} 60% 42%)`, `hsl(${(h + 45) % 360} 58% 62%)`];
}

export default function OrdersTable({ orders }) {
  if (!orders || orders.length === 0) {
    return <div className="empty-state">No recent orders.</div>;
  }

  return (
    <div>
      {orders.map((o, i) => {
        const { meta, matchup, held, opponent } = decode(o.ticker);
        const [primary, secondary] = colorFor(held || matchup || o.ticker);
        const isBuy = String(o.action || "").toLowerCase() === "buy";
        const title = held && opponent ? `${held} vs ${opponent}` : (matchup || "—");

        const costDollars =
          o.priceCents != null && o.count != null ? (o.priceCents * o.count) / 100 : null;

        return (
          <div key={o.orderId || `${o.ticker}-${i}`} className="kx-order">
            <div
              className="kx-tile kx-tile-sm"
              style={{ background: primary, border: `2px solid ${secondary}` }}
            >
              {meta.key === "esports" ? "🎮" : sportEmoji(meta.key)}
            </div>

            <div className="kx-order-body">
              <div className="kx-order-title">{title}</div>
              <div className="kx-status">
                <span>{meta.label}</span>
                {held && <><span className="kx-sep">·</span><span>on {held}</span></>}
                {o.createdTime && <><span className="kx-sep">·</span><span>{when(o.createdTime)}</span></>}
              </div>
            </div>

            <div className="kx-order-right">
              <span className={`kx-pill ${isBuy ? "kx-pill-buy" : "kx-pill-sell"}`}>
                {isBuy ? "Buy" : "Sell"}
              </span>
              <div className="kx-order-sub">
                {o.priceCents != null ? `${o.priceCents}¢` : ""}
                {o.count != null ? ` × ${o.count}` : ""}
              </div>
              <div className="kx-order-sub">
                {costDollars != null ? `$${costDollars.toFixed(2)}` : ""}
                {o.status ? ` · ${o.status}` : ""}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
