import React, { useEffect, useState } from "react";

/**
 * TRADE COUNTER (2026-10-06).
 *
 * Today's work and results at a glance: scans run, markets priced, trades by
 * exchange and lane, pace against the daily target, and the day's top
 * blockers. The pace is what the bot adjusts on - behind pace, an area the
 * learner blocked may take one half-stake probation trade (server/src/tradeCounter.js).
 * Refreshes every 30 seconds.
 */

function resolveBase(apiBase) {
  if (typeof apiBase === "string" && apiBase && apiBase !== "undefined") return apiBase;
  const env = import.meta.env.VITE_API_BASE;
  if (typeof env === "string" && env && env !== "undefined") return env;
  return "";
}

function Row({ label, value, tone }) {
  return (
    <div className="trade-row">
      <span>{label}</span>
      <span className={tone || ""}>{String(value ?? "—")}</span>
    </div>
  );
}

const LANE_LABEL = { dip: "Dip lane (35-49c)", middle: "Middle lane (50-92c)", favorite: "Favorite lane (65%+ to win)" };

export default function TradeCounterPanel({ apiBase }) {
  const base = resolveBase(apiBase);
  const [r, setR] = useState(null);
  const [error, setError] = useState(null);

  async function load() {
    try {
      const res = await fetch(`${base}/api/trade-counter`);
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { throw new Error(`Server returned ${res.status}: ${text.slice(0, 200)}`); }
      if (data.error) throw new Error(data.error);
      setR(data); setError(null);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, []);

  const pace = r?.pace;
  const paceTone = pace?.status === "behind" ? "neg" : "pos";

  return (
    <div className="panel">
      <h2>Trade Counter · Today</h2>
      {error && <div className="error-banner">{error}</div>}
      {!r && !error && <div className="empty-state">Loading...</div>}
      {r && (
        <>
          <Row label="Trades today" value={`${r.entered.kalshi} Kalshi · ${r.entered.polymarket} Polymarket`} />
          <Row label="Pace" value={`${pace.entered} of ${pace.targetPerDay} target (${pace.expectedByNow} expected by now) - ${pace.status}`} tone={paceTone} />
          <div className="ledger-reason" style={{ marginTop: 4 }}>{pace.adjustment}</div>

          <div className="bot-subsection">
            <h3>By lane (Kalshi)</h3>
            {Object.keys(r.byLane).length === 0 && <div className="empty-state">No Kalshi trades yet today.</div>}
            {Object.entries(r.byLane).map(([lane, n]) => <Row key={lane} label={LANE_LABEL[lane] || lane} value={n} />)}
            {r.probationToday.length > 0 && <Row label="Probation trades" value={r.probationToday.map((p) => p.segment).join(", ")} />}
          </div>

          <div className="bot-subsection">
            <h3>Bot activity</h3>
            <Row label="Scans run" value={r.scans.toLocaleString()} />
            <Row label="Sports scanned" value={r.sportsScanned} />
            <Row label="Markets priced" value={r.marketsPriced.toLocaleString()} />
          </div>

          <div className="bot-subsection">
            <h3>Top blockers today</h3>
            {r.blockers.length === 0 && <div className="empty-state">Nothing refused yet today.</div>}
            {r.blockers.map((b) => <Row key={b.code} label={b.label} value={b.count.toLocaleString()} />)}
          </div>

          {r.entries.length > 0 && (
            <div className="bot-subsection">
              <h3>Today's trades</h3>
              {r.entries.map((e, i) => (
                <Row key={i}
                  label={`${new Date(e.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} · ${e.venue === "polymarket" ? "PM" : "Kalshi"} · ${e.team || e.ticker}`}
                  value={`${e.contracts} @ ${e.priceCents}c`} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

