import React, { useEffect, useState } from "react";

/**
 * Scanner - Kalshi and Polymarket kept apart.
 *
 * Every team the chosen exchange's scanner priced in the last 15 minutes,
 * with the price, the fair value from the betting line, and the verdict in
 * plain words: bought, or the exact rule that stopped it. Below that, any
 * game the live schedule has in play that this exchange did not look at, and
 * why. Refreshes every 10 seconds.
 */

const TABS = [["kalshi", "Kalshi"], ["polymarket", "Polymarket"]];

// Short, plain names for the reasons. The detail line under each row says
// exactly what was measured.
const LABEL = {
  bought: "Bought",
  "double-down": "Bought (double-down)",
  "already-held": "Already holding this game",
  "pm-already-held": "Already holding this game",
  "opposite-of-polymarket": "Other team of a game Polymarket holds",
  "pm-opposite-of-kalshi": "Other team of a game Kalshi holds",
  "price-below-floor": "Price under the live band",
  "pm-price-below-floor": "Price under the live band",
  "price-above-ceiling": "Price over the live band",
  "pm-price-above-ceiling": "Price over the live band",
  "edge-too-small": "No edge at this price",
  "pm-edge-too-small": "No edge at this price",
  "edge-implausible": "Gap to the betting line too big - stale line",
  "pm-edge-implausible": "Gap to the betting line too big - stale line",
  "return-too-small": "Expected return under the minimum",
  "pm-return-too-small": "Expected return under the minimum",
  "model-disagrees": "In-game model disagrees with the line",
  "pm-model-disagrees": "In-game model disagrees with the line",
  "no-live-score-match": "No live score found",
  "pm-no-live-score": "No live score found",
  unmodellable: "Game state can't be modelled",
  "pm-unmodellable": "Game state can't be modelled",
  "no-model-for-sport": "No in-game model for this sport",
  "pm-no-model": "No in-game model for this sport",
  "live-scores-unavailable": "Live scores unavailable",
  "spread-too-wide": "Spread too wide",
  "pm-spread-too-wide": "Spread too wide",
  "no-price": "No price in the book",
  "pm-no-price": "No price in the book",
  "at-cap": "At the open-trade cap",
  "pm-at-cap": "At the open-trade cap",
  "learned-block": "Sport/price band has been losing",
  "pm-learned-block": "Sport/price band has been losing",
  "no-fill": "Order sent, nothing filled",
  "pm-no-fill": "Order sent, nothing filled",
  "order-error": "Order failed",
  "pm-order-error": "Order failed",
  "pm-order-rejected": "Order rejected",
  "market-closed": "Market closed",
  "pm-market-not-open": "Market closed",
  "pm-game-not-listed": "Game not found on Polymarket",
  "pm-game-ambiguous": "Game matched twice - skipped",
  "pm-no-side-not-confirmed": "NO side not switched on yet",
  "pm-would-trade": "Would buy - trading not active",
  "pm-halted": "Paused today (loss limit)",
  "pm-paused-after-failures": "Paused after failed orders",
  "pm-size-zero": "Not enough cash for one contract",
  "live-trading-off": "Live trading switched off",
  "waiting-for-bid-cancel": "Clearing a resting bid first",
  "fetch-error": "Couldn't read the market",
  "pm-price-failed": "Couldn't read the price",
  "pm-side-unknown": "Couldn't tie a market side to the team",
  "pm-side-ambiguous": "Team on more than one side",
  "pm-team-not-in-event": "Team not in the Polymarket game",
  "pm-no-winner-market": "No open winner market",
};

function label(code) {
  if (!code) return "Skipped";
  if (LABEL[code]) return LABEL[code];
  if (code.startsWith("unresolved:")) return "No Kalshi market found";
  if (code.startsWith("skipped:")) return "Order not placed";
  return code;
}

function title(s) {
  return String(s || "").replace(/\b\w/g, (m) => m.toUpperCase());
}

function prettySport(key) {
  return String(key || "")
    .replace(/^americanfootball_/, "")
    .replace(/^basketball_/, "")
    .replace(/^baseball_/, "")
    .replace(/^icehockey_/, "")
    .replace(/^soccer_/, "")
    .replace(/^tennis_/, "tennis ")
    .replace(/_/g, " ")
    .toUpperCase();
}

function ago(iso) {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

function readTab() {
  try {
    const v = localStorage.getItem("kx-scanner-tab");
    return TABS.some(([k]) => k === v) ? v : "kalshi";
  } catch {
    return "kalshi";
  }
}

const HEAD = { display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 };

// Not a problem - the game is already covered - so shown without the red.
const NEUTRAL = new Set(["already-held", "pm-already-held", "opposite-of-polymarket", "pm-opposite-of-kalshi", "waiting-for-bid-cancel"]);

export default function ScannerPanel({ apiBase }) {
  const [tab, setTab] = useState(readTab);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [, setTick] = useState(0);

  async function refresh(which = tab) {
    try {
      const res = await fetch(`${apiBase}/api/scanner?venue=${which}`);
      const body = await res.json();
      if (body.error) throw new Error(body.error);
      if (body.venue === which) setData(body);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    setData(null);
    refresh(tab);
    const poll = setInterval(() => refresh(tab), 10000);
    const tick = setInterval(() => setTick((n) => n + 1), 5000);
    return () => { clearInterval(poll); clearInterval(tick); };
  }, [tab]);

  function choose(v) {
    try { localStorage.setItem("kx-scanner-tab", v); } catch { /* still works for this visit */ }
    setTab(v);
  }

  const name = tab === "polymarket" ? "Polymarket" : "Kalshi";
  const rows = data?.rows || [];
  const notLooked = data?.notLooked || [];

  return (
    <div className="panel">
      <h2>Scanner</h2>
      <div className="env-pill-group" role="tablist" aria-label="Scanner exchange"
        style={{ display: "flex", width: "100%", boxSizing: "border-box", margin: "6px 0 12px" }}>
        {TABS.map(([v, text]) => (
          <button key={v} type="button" role="tab" aria-selected={tab === v}
            className={`env-pill ${tab === v ? "env-pill-active" : ""}`}
            style={{ flex: 1, padding: "10px 6px" }}
            onClick={() => choose(v)}>
            {text}
          </button>
        ))}
      </div>

      <p className="setup-copy">
        Every team the {name} scanner priced in the last 15 minutes and what it decided.
        A game is bought only when the {name} price clears every rule on its own.
      </p>

      {error && <div className="error-banner" style={{ marginTop: 12 }}>{error}</div>}
      {!data && !error && <div className="ledger-reason">Loading...</div>}

      {data && (
        <>
          <div className="ledger-figures ledger-summary">
            <div><span>Last scan</span><strong>{ago(data.lastScanAt)}</strong></div>
            <div><span>Teams priced</span><strong>{data.counts?.teams ?? 0}</strong></div>
            <div><span>Bought</span><strong className={data.counts?.bought ? "pos" : ""}>{data.counts?.bought ?? 0}</strong></div>
            <div><span>Live games</span><strong>{data.schedule?.liveGames ?? "—"}</strong></div>
          </div>

          {!rows.length && (
            <div className="ledger-reason" style={{ marginTop: 10 }}>
              {data.lastScanAt
                ? `Nothing priced on ${name} in the last 15 minutes - no game was live or starting in its covered leagues.`
                : `The ${name} scanner has not run since the last restart - it starts with the next cycle.`}
            </div>
          )}

          {rows.map((r) => (
            <div key={`${r.sportKey}-${r.team}`} className="ledger-card" style={{ marginTop: 8 }}>
              <div className="ledger-card-head" style={HEAD}>
                <span>{title(r.team)}{r.opponent ? <span style={{ fontWeight: 400, opacity: 0.75 }}> vs {title(r.opponent)}</span> : null}</span>
                <span className={r.verdict === "bought" ? "pos" : r.verdict === "tried" || NEUTRAL.has(r.code) ? "" : "neg"}>
                  {r.verdict === "bought" ? "✅ " : ""}{label(r.code)}
                </span>
              </div>
              <div className="ledger-reason">
                {prettySport(r.sportKey)}
                {r.priceCents != null ? ` · price ${r.priceCents}¢` : ""}
                {r.fairPct != null ? ` · fair ${r.fairPct}%` : ""}
                {` · ${ago(r.lastCheckedAt || r.at)}`}
              </div>
              {r.why && <div className="ledger-reason" style={{ marginTop: 4 }}>{r.why}</div>}
            </div>
          ))}

          {notLooked.length > 0 && (
            <div className="bot-subsection">
              <h3 style={{ margin: "14px 0 6px" }}>Live now, not priced on {name}</h3>
              {notLooked.map((g) => (
                <div key={`${g.sportKey}-${g.home}-${g.away}`} className="ledger-card">
                  <div className="ledger-card-head" style={HEAD}>
                    <span>{g.home ?? "?"} v {g.away ?? "?"}</span>
                    <span>{g.minutesIn != null ? `${g.minutesIn} min in` : ""}</span>
                  </div>
                  <div className="ledger-reason">{prettySport(g.sportKey)} · {g.why}</div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
