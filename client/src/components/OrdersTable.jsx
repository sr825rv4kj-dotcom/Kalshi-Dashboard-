import React from "react";
import { sportEmoji } from "../teamIdentity.js";

/**
 * Kalshi's own order history carries only tickers, so the matchup and side are
 * decoded from the ticker itself: KXMLBGAME-26SEP18ATLPHI-PHI.
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
  return { meta, matchup: m ? m[2] : middle, side };
}

function when(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

export default function OrdersTable({ orders }) {
  if (!orders || orders.length === 0) {
    return <div className="empty-state">No recent orders.</div>;
  }

  return (
    <div>
      {orders.map((o, i) => {
        const { meta, matchup, side } = decode(o.ticker);
        const isBuy = String(o.action || "").toLowerCase() === "buy";

        return (
          <div key={o.orderId || `${o.ticker}-${i}`} className="kx-order">
            <div className="kx-tile kx-tile-sm">
              {meta.key === "esports" ? "🎮" : sportEmoji(meta.key)}
            </div>

            <div className="kx-order-body">
              <div className="kx-order-title">{side ? `${side} · ` : ""}{matchup || "—"}</div>
              <div className="kx-status">
                <span>{meta.label}</span>
                {o.createdTime && <><span className="kx-sep">·</span><span>{when(o.createdTime)}</span></>}
              </div>
            </div>

            <div className="kx-order-right">
              <span className={`kx-pill ${isBuy ? "kx-pill-buy" : "kx-pill-sell"}`}>
                {isBuy ? "Buy" : "Sell"} {o.side || ""}
              </span>
              <div className="kx-order-sub">
                {o.priceCents != null ? `${o.priceCents}¢` : ""}
                {o.count != null ? ` × ${o.count}` : ""}
              </div>
              <div className="kx-order-sub">{o.status || ""}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
