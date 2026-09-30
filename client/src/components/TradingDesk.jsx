import React, { useEffect, useState } from "react";

/**
 * Trading Desk - the swing trading book on both exchanges.
 *
 * Buy the dip (price under what the score and clock say the team is worth),
 * sell the rally (half when the price is back at fair value, the rest at
 * +65%), cut blowouts, repeat. Every open position shows its live bid, fair
 * value, profit so far and the exact price of its next sale; today's profit
 * is measured against the daily goal. Refreshes every 10 seconds from what
 * the bot saw on its last check.
 */

const HEAD = { display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 };
const ROW = { display: "flex", flexWrap: "wrap", gap: "4px 14px", marginTop: 6, fontSize: 14 };

function money(n, sign = true) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  const v = Number(n);
  const s = `$${Math.abs(v).toFixed(2)}`;
  if (!sign) return s;
  return v > 0 ? `+${s}` : v < 0 ? `-${s}` : s;
}

function cls(n) {
  return n > 0 ? "pos" : n < 0 ? "neg" : "";
}

function title(s) {
  return String(s || "").replace(/\b\w/g, (m) => m.toUpperCase());
}

function prettySport(key) {
  return String(key || "")
    .replace(/^(americanfootball|basketball|baseball|icehockey|soccer)_/, "")
    .replace(/^tennis_/, "tennis ")
    .replace(/_/g, " ")
    .toUpperCase();
}

function ago(iso) {
  if (!iso) return "";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

function clockTime(iso) {
  try { return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); } catch { return ""; }
}

const ACTION_LABEL = {
  hold: "Holding",
  "no-bid": "No bid",
  "no-price": "Price unreadable",
  "sell-not-confirmed": "Sell waiting on Polymarket check",
  "trading-off": "Trading off",
  "sell-error": "Sell failed - retrying",
  "rally-half": "Selling half",
  target: "Selling at target",
  blowout: "Cutting blowout",
  "blowout-market": "Cutting blowout",
};

function plan(p) {
  const parts = [];
  if (!p.soldHalf && p.halfAtCents != null) parts.push(`half at ${p.halfAtCents}¢`);
  if (p.soldHalf) parts.push("half sold");
  parts.push(p.targetAtCents != null ? `${p.soldHalf ? "rest" : "all"} at ${p.targetAtCents}¢ (+65%)` : "holds to settlement");
  return parts.join(" · ");
}

function Fig({ label, value, tone = "" }) {
  return (
    <div className="ledger-card" style={{ margin: 0, padding: "10px 12px" }}>
      <div className="balance-label" style={{ fontSize: 11 }}>{label}</div>
      <div className={tone} style={{ fontSize: 18, fontWeight: 700, marginTop: 2, fontVariantNumeric: "tabular-nums" }}>{value}</div>
    </div>
  );
}

function Position({ p }) {
  const label = ACTION_LABEL[p.code] || ACTION_LABEL[p.action] || p.action;
  return (
    <div className="ledger-card" style={{ marginTop: 8 }}>
      <div className="ledger-card-head" style={HEAD}>
        <span>
          {title(p.teamName)} <span style={{ fontWeight: 400, opacity: 0.7 }}>{p.side}</span>
        </span>
        <span className={cls(p.unrealizedDollars)}>
          {money(p.unrealizedDollars)}{p.gainPct != null ? ` (${p.gainPct > 0 ? "+" : ""}${p.gainPct}%)` : ""}
        </span>
      </div>
      <div style={ROW}>
        <span>{p.contracts} @ {p.entryCents}¢</span>
        <span>bid {p.bidCents ?? "—"}¢</span>
        <span>fair {p.fairPct != null ? `${p.fairPct}%` : "—"}</span>
        {p.modelPct != null && <span>score+clock {p.modelPct}%</span>}
      </div>
      {p.score && (
        <div className="ledger-reason" style={{ marginTop: 4 }}>
          {p.score}{p.minutesLeftPct != null ? ` · ~${p.minutesLeftPct}% of the game left` : ""} · {prettySport(p.sportKey)}
        </div>
      )}
      <div className="ledger-reason" style={{ marginTop: 4 }}>
        <strong style={{ fontWeight: 650 }}>{label}</strong> · {plan(p)} · checked {ago(p.at)}
      </div>
      {p.code !== "hold" && p.why && <div className="ledger-reason" style={{ marginTop: 4 }}>{p.why}</div>}
    </div>
  );
}

function Venue({ name, v, cap, note }) {
  const positions = v?.positions || [];
  return (
    <div className="bot-subsection">
      <h3 style={{ margin: "16px 0 4px", ...HEAD }}>
        <span>{name}</span>
        <span style={{ fontSize: 13, fontWeight: 500, opacity: 0.8 }}>
          {cap ? `${cap.open ?? positions.length} open of ${cap.cap ?? "—"}` : `${positions.length} open`}
        </span>
      </h3>
      <div className="ledger-reason">
        Today: <span className={cls(v?.realizedDollars)}>{money(v?.realizedDollars)}</span> banked ·{" "}
        {v?.roundTrips ?? 0} round trip{v?.roundTrips === 1 ? "" : "s"} ({v?.wins ?? 0} won, {v?.losses ?? 0} lost) ·{" "}
        {v?.sells ?? 0} sell{v?.sells === 1 ? "" : "s"}
      </div>
      {note && <div className="ledger-reason" style={{ marginTop: 4 }}>{note}</div>}
      {!positions.length && <div className="ledger-reason" style={{ marginTop: 6 }}>No open position - waiting for the next dip on a live game.</div>}
      {positions.map((p) => <Position key={`${p.ticker}-${p.openedAt}`} p={p} />)}
    </div>
  );
}

function pmSellNote(check) {
  if (!check) return null;
  const bad = ["long", "short"].filter((k) => check[k] && check[k].ok === false);
  if (!bad.length) return null;
  return `Polymarket selling (${bad.map((k) => (k === "long" ? "YES" : "NO")).join(", ")} side) is waiting on Polymarket's check: ${check[bad[0]].detail}`;
}

export default function TradingDesk({ apiBase }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [, setTick] = useState(0);

  async function refresh() {
    try {
      const res = await fetch(`${apiBase}/api/desk`);
      const body = await res.json();
      if (body.error) throw new Error(body.error);
      setData(body);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    refresh();
    const poll = setInterval(refresh, 10000);
    const tick = setInterval(() => setTick((n) => n + 1), 5000);
    return () => { clearInterval(poll); clearInterval(tick); };
  }, []);

  const g = data?.goal || {};
  const pct = g.goalDollars > 0 ? Math.max(0, Math.min(100, (g.totalDollars / g.goalDollars) * 100)) : 0;
  const s = data?.settings || {};

  return (
    <div className="panel">
      <h2 style={HEAD}>
        <span>Trading Desk</span>
        {data && (
          <span style={{ textTransform: "none", letterSpacing: 0, fontWeight: 500 }}>
            {data.botRunning ? <span className="live-badge">{data.liveGames ?? 0} live</span> : <span className="neg">Bot stopped</span>}
          </span>
        )}
      </h2>

      {error && <div className="error-banner">{error}</div>}
      {!data && !error && <div className="ledger-reason">Loading the desk...</div>}

      {data && (
        <>
          <div style={HEAD}>
            <div>
              <div className="balance-label">Today's profit</div>
              <div className={`pnl-headline ${cls(g.totalDollars)}`} style={{ fontSize: 30, fontWeight: 750 }}>{money(g.totalDollars)}</div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div className="balance-label">Goal ({s.dailyGoalPct ?? 40}%)</div>
              <div style={{ fontSize: 20, fontWeight: 650 }}>{g.goalDollars != null ? money(g.goalDollars, false) : "—"}</div>
            </div>
          </div>
          <div className="milestone-track">
            <div className="milestone-bar-bg"><div className="milestone-bar-fill" style={{ width: `${pct}%` }} /></div>
            <div className="milestone-labels" style={{ fontSize: 12.5, marginTop: 6 }}>
              <span>{g.pctOfStart != null ? `${g.pctOfStart > 0 ? "+" : ""}${g.pctOfStart}% of today's start` : "Start of day not recorded yet"}</span>
              <span>{g.startEquity != null ? `start ${money(g.startEquity, false)} · double at ${money(g.startEquity * 2, false)}` : ""}</span>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginTop: 14 }}>
            <Fig label="Banked today" value={money(g.realizedDollars)} tone={cls(g.realizedDollars)} />
            <Fig label="Open now" value={money(g.unrealizedDollars)} tone={cls(g.unrealizedDollars)} />
            <Fig label="Round trips" value={(data.kalshi?.roundTrips ?? 0) + (data.polymarket?.roundTrips ?? 0)} />
          </div>

          <div className="ledger-reason" style={{ marginTop: 10 }}>
            Buys a live team when its price is under what the score and clock say it's worth ({s.minExpectedReturnPct ?? 10}%+ expected after fees).
            Sells half when the price climbs back to fair value, the rest at +{s.targetPct ?? 65}%, and everything if the game becomes a blowout
            (under {s.blowoutBelowPct ?? 10}% to win). A sold game can be bought again on the next dip after {s.reentryMinutes ?? 3} minutes.
            {s.enabled === false ? " Swing trading is OFF - positions are held to settlement." : ""}
          </div>

          <Venue name="Kalshi" v={data.kalshi} cap={data.caps?.kalshi} />
          <Venue name="Polymarket" v={data.polymarket} cap={data.caps?.polymarket} note={pmSellNote(data.polymarketSelling)} />

          {(data.kalshi?.games?.length || data.polymarket?.games?.length) ? (
            <div className="bot-subsection">
              <h3 style={{ margin: "16px 0 4px" }}>Round trips by game today</h3>
              {[...(data.kalshi?.games || []).map((x) => ({ ...x, venue: "Kalshi" })), ...(data.polymarket?.games || []).map((x) => ({ ...x, venue: "Polymarket" }))].map((x, i) => (
                <div key={i} className="ledger-reason" style={HEAD}>
                  <span>{title(x.game)} · {x.venue} · {x.roundTrips}×</span>
                  <span className={cls(x.net)}>{money(x.net)}</span>
                </div>
              ))}
            </div>
          ) : null}

          {data.recentSells?.length ? (
            <div className="bot-subsection">
              <h3 style={{ margin: "16px 0 4px" }}>Sells today</h3>
              {data.recentSells.map((r, i) => (
                <div key={i} className="ledger-reason" style={HEAD}>
                  <span>
                    {clockTime(r.at)} · {title(r.team)} · {r.venue === "polymarket" ? "PM" : "K"} · {r.contracts} @ {r.entryCents}¢ → {r.exitCents}¢ ·{" "}
                    {String(r.reason || "").replace(/^swing-/, "").replace("rally-half", "half at fair").replace("blowout-market", "blowout").replace(/^settled-/, "settled ")}
                  </span>
                  <span className={cls(r.net)}>{money(r.net)}</span>
                </div>
              ))}
            </div>
          ) : null}

          {data.nextGame && !data.liveGames ? (
            <div className="ledger-reason" style={{ marginTop: 12 }}>
              No game live right now. Next: {prettySport(data.nextGame.sportKey)} · {data.nextGame.home} v {data.nextGame.away} at {clockTime(data.nextGame.commence)}.
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
