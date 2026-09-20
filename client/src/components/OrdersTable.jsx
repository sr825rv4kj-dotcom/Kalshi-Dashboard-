import React from "react";
import { sportEmoji } from "../teamIdentity.js";

/**
 * Kalshi's raw order feed carries only tickers, so both sides of the game are
 * decoded from the ticker itself:
 *   KXNCAAFGAME-26SEP19MONTORST-MONT
 *   series ......^ date ^ matchup ^ side
 * The matchup segment is the two team codes concatenated; stripping the side
 * code leaves the opponent.
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

  const m = middle.match(/^(\d{2}[A-Z]{3}\d{2})(.*)$/);
  const matchup = m ? m[2] : middle;

  let opponent = null;
  if (side && matchup.startsWith(side)) opponent = matchup.slice(side.length) || null;
  else if (side && matchup.endsWith(side)) opponent = matchup.slice(0, -side.length) || null;

  return { meta, matchup, held: side || null, opponent };
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

/**
 * Pairs sells against earlier buys on the same ticker, oldest first, so every
 * sell can report what it actually made. Kalshi's order feed has no P&L of its
 * own - each row is just a fill - so the realized result has to be reconstructed
 * here from the matching buys.
 */
function annotateRealized(orders) {
  const chronological = [...orders].sort(
    (a, b) => new Date(a.createdTime || 0) - new Date(b.createdTime || 0)
  );

  const lots = {}; // ticker -> [{ priceCents, count }]
  const realized = {}; // orderId -> { net, roiPct, costBasis }

  for (const o of chronological) {
    const count = Number(o.count) || 0;
    const price = Number(o.priceCents) || 0;
    if (!count || !price) continue;

    const isBuy = String(o.action || "").toLowerCase() === "buy";
    lots[o.ticker] = lots[o.ticker] || [];

    if (isBuy) {
      lots[o.ticker].push({ priceCents: price, count });
      continue;
    }

    // Sell: consume the oldest buys first.
    let remaining = count;
    let costCents = 0;
    while (remaining > 0 && lots[o.ticker].length) {
      const lot = lots[o.ticker][0];
      const take = Math.min(remaining, lot.count);
      costCents += take * lot.priceCents;
      lot.count -= take;
      remaining -= take;
      if (lot.count <= 0) lots[o.ticker].shift();
    }

    const matched = count - remaining;
    if (matched > 0) {
      const proceedsCents = matched * price;
      const net = (proceedsCents - costCents) / 100;
      realized[o.orderId || `${o.ticker}-${o.createdTime}`] = {
        net,
        costBasis: costCents / 100,
        roiPct: costCents > 0 ? (net / (costCents / 100)) * 100 : null,
      };
    }
  }

  return realized;
}

export default function OrdersTable({ orders }) {
  if (!orders || orders.length === 0) {
    return <div className="empty-state">No recent orders.</div>;
  }

  const realized = annotateRealized(orders);

  return (
    <div>
      {orders.map((o, i) => {
        const { meta, matchup, held, opponent } = decode(o.ticker);
        const [primary, secondary] = colorFor(held || matchup || o.ticker);
        const isBuy = String(o.action || "").toLowerCase() === "buy";
        const title = held && opponent ? `${held} vs ${opponent}` : (matchup || "—");

        const dollars =
          o.priceCents != null && o.count != null ? (o.priceCents * o.count) / 100 : null;

        const r = realized[o.orderId || `${o.ticker}-${o.createdTime}`];
        const won = r ? r.net > 0 : false;

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
              <div className="kx-order-sub">
                {isBuy ? "Entered" : "Exited"}{" "}
                {dollars != null ? `$${dollars.toFixed(2)}` : "—"}
                {o.priceCents != null ? ` · ${o.priceCents}¢ × ${o.count}` : ""}
              </div>
            </div>

            <div className="kx-order-right">
              <span className={`kx-pill ${isBuy ? "kx-pill-buy" : "kx-pill-sell"}`}>
                {isBuy ? "Buy" : "Sell"}
              </span>

              {r ? (
                <>
                  <div className={`kx-order-pnl ${won ? "kx-pos" : "kx-neg"}`}>
                    {won ? "+" : ""}${r.net.toFixed(2)}
                  </div>
                  <div className={`kx-order-sub ${won ? "kx-pos" : "kx-neg"}`}>
                    {r.roiPct == null ? "" : `${r.roiPct > 0 ? "+" : ""}${r.roiPct.toFixed(1)}% ROI`}
                  </div>
                </>
              ) : (
                <div className="kx-order-sub">{isBuy ? "open" : o.status || ""}</div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
