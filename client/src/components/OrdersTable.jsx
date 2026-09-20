import React, { useEffect, useState } from "react";
import { teamIdentity, sportEmoji, sportLabel } from "../teamIdentity.js";

/**
 * A statement, not an order feed.
 *
 * Kalshi's order endpoint returns tickers with no team names and, since the v2
 * migration, no usable quantity - which is why this panel showed "8c x null"
 * and no dollars. The bot's own ledger records the actual fill price, the
 * actual contract count, the reason, and the matching exit, so every figure
 * here is real money rather than a reconstruction.
 */
function money(n) {
  if (n == null) return "—";
  return `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;
}

function when(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

/** Opponent code from the ticker: KX...-26SEP19MONTORST-MONT -> ORST */
function opponentFrom(ticker) {
  const parts = String(ticker || "").split("-");
  const side = parts[2] || "";
  const middle = (parts[1] || "").replace(/^\d{2}[A-Z]{3}\d{2}/, "");
  if (!side || !middle) return null;
  if (middle.startsWith(side)) return middle.slice(side.length) || null;
  if (middle.endsWith(side)) return middle.slice(0, -side.length) || null;
  return null;
}

/** Cumulative P&L sparkline - green when the run is up, red when it is down. */
function Sparkline({ values }) {
  if (!values || values.length < 2) return null;

  const w = 120;
  const h = 34;
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 0);
  const span = max - min || 1;

  const points = values.map((v, i) => {
    const x = (i / (values.length - 1)) * w;
    const y = h - ((v - min) / span) * h;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const last = values[values.length - 1];
  const up = last >= 0;
  const stroke = up ? "#21c17a" : "#ff4d4f";
  const zeroY = h - ((0 - min) / span) * h;

  return (
    <svg width={w} height={h} className="kx-spark" role="img" aria-label="Cumulative profit and loss">
      <line x1="0" y1={zeroY} x2={w} y2={zeroY} stroke="currentColor" strokeOpacity="0.25" strokeDasharray="3 3" />
      <polyline
        points={points.join(" ")}
        fill="none"
        stroke={stroke}
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={w} cy={points[points.length - 1].split(",")[1]} r="3" fill={stroke} />
    </svg>
  );
}

function StatementRow({ t, runningBalance }) {
  const id = teamIdentity(t.teamName, t.sportKey);
  const opponent = opponentFrom(t.ticker);
  const win = (t.netDollars ?? 0) > 0;

  return (
    <div className="kx-stmt-row">
      <div className="kx-stmt-main">
        <div className="kx-stmt-icon" style={{ background: id.primary, borderColor: id.secondary }}>
          {sportEmoji(t.sportKey)}
        </div>
        <div className="kx-stmt-text">
          <div className="kx-stmt-title">
            {id.name}{opponent ? ` vs ${opponent}` : ""}
          </div>
          <div className="kx-stmt-sub">
            {sportLabel(t.sportKey)} · {t.contracts} @ {t.entryPriceCents}¢ → {t.exitPriceCents}¢ · {t.exitReason}
          </div>
          <div className="kx-stmt-sub">{when(t.entryTimestamp)} → {when(t.exitTimestamp)}</div>
        </div>
      </div>

      <div className="kx-stmt-figures">
        <div><span>In</span><strong>{money(t.costDollars)}</strong></div>
        <div><span>Out</span><strong>{money(t.proceedsDollars)}</strong></div>
        <div>
          <span>Net</span>
          <strong className={win ? "kx-pos" : "kx-neg"}>{win ? "+" : ""}{money(t.netDollars)}</strong>
        </div>
        <div>
          <span>ROI</span>
          <strong className={win ? "kx-pos" : "kx-neg"}>
            {t.roiPct == null ? "—" : `${t.roiPct > 0 ? "+" : ""}${t.roiPct.toFixed(1)}%`}
          </strong>
        </div>
        <div>
          <span>Balance</span>
          <strong className={runningBalance >= 0 ? "kx-pos" : "kx-neg"}>
            {runningBalance >= 0 ? "+" : ""}{money(runningBalance)}
          </strong>
        </div>
      </div>
    </div>
  );
}

export default function OrdersTable() {
  const [data, setData] = useState({ completed: [], open: [], stats: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  async function load() {
    try {
      setError(null);
      const res = await fetch(`/api/trade-lifecycles`);
      const text = await res.text();
      let json;
      try { json = JSON.parse(text); }
      catch { throw new Error(`Server returned ${res.status}. Close the tab and reopen to clear a stale build.`); }
      if (json.error) throw new Error(json.error);
      setData({ completed: json.completed ?? [], open: json.open ?? [], stats: json.stats ?? null });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const i = setInterval(load, 60000);
    return () => clearInterval(i);
  }, []);

  // Oldest first for the running balance, then show newest at the top.
  const chronological = [...data.completed].reverse();
  let running = 0;
  const withBalance = chronological.map((t) => {
    running += t.netDollars ?? 0;
    return { t, balance: running };
  });
  const curve = withBalance.map((r) => r.balance);
  const newestFirst = [...withBalance].reverse();

  const s = data.stats;

  if (loading) return <p className="muted">Loading statement...</p>;
  if (error) return <div className="error-banner">{error}</div>;

  return (
    <div>
      <div className="kx-stmt-header">
        <div>
          <div className="kx-stmt-hlabel">Realized P&amp;L</div>
          <div className={`kx-stmt-hvalue ${(s?.totalNetDollars ?? 0) >= 0 ? "kx-pos" : "kx-neg"}`}>
            {(s?.totalNetDollars ?? 0) >= 0 ? "+" : ""}{money(s?.totalNetDollars ?? 0)}
          </div>
          <div className="kx-stmt-sub">
            {s?.totalExits ?? 0} closed · {s?.wins ?? 0}W / {s?.losses ?? 0}L
            {s?.winRatePct != null ? ` · ${s.winRatePct.toFixed(0)}% win rate` : ""}
            {s?.overallRoiPct != null ? ` · ${s.overallRoiPct > 0 ? "+" : ""}${s.overallRoiPct.toFixed(1)}% ROI` : ""}
          </div>
        </div>
        <Sparkline values={curve} />
      </div>

      {data.open.length > 0 && (
        <div className="kx-stmt-open">
          {data.open.length} position{data.open.length === 1 ? "" : "s"} still open ·{" "}
          {money(data.open.reduce((sum, t) => sum + (t.costDollars ?? 0), 0))} at risk
        </div>
      )}

      {newestFirst.length === 0 ? (
        <div className="empty-state">No completed trades yet.</div>
      ) : (
        newestFirst.map(({ t, balance }, i) => (
          <StatementRow key={`${t.ticker}-${t.entryTimestamp}-${i}`} t={t} runningBalance={balance} />
        ))
      )}
    </div>
  );
}
