import React, { useEffect, useState } from "react";
import ScrubChart from "./ScrubChart.jsx";
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
  const middle = (parts[1] || "").replace(/^\d{2}[A-Z]{3}\d{2}(\d{4})?/, "");
  if (!side || !middle) return null;
  if (middle.startsWith(side)) return middle.slice(side.length) || null;
  if (middle.endsWith(side)) return middle.slice(0, -side.length) || null;
  return null;
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
  // Collapsed by default, remembered on this device. Storage can be blocked
  // (private browsing), so every access is guarded.
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem("kx-statement-open") === "1"; } catch { return false; }
  });
  const toggle = () => setOpen((v) => {
    const next = !v;
    try { localStorage.setItem("kx-statement-open", next ? "1" : "0"); } catch { /* ignore */ }
    return next;
  });

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
  const scrubPoints = withBalance.map(({ t, balance: b }) => {
    const opp = opponentFrom(t.ticker);
    return {
      value: b,
      change: t.netDollars ?? 0,
      label: `${teamIdentity(t.teamName, t.sportKey).name}${opp ? ` vs ${opp}` : ""}`,
      sub: `${sportLabel(t.sportKey)} · ${t.contracts} @ ${t.entryPriceCents}¢ → ${t.exitPriceCents}¢ · ${t.exitReason}`,
      date: t.exitTimestamp,
    };
  });
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
      </div>

      <ScrubChart points={scrubPoints} height={120} compact />

      {data.open.length > 0 && (
        <div className="kx-stmt-open">
          {data.open.length} position{data.open.length === 1 ? "" : "s"} still open ·{" "}
          {money(data.open.reduce((sum, t) => sum + (t.costDollars ?? 0), 0))} at risk
        </div>
      )}

      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        style={{
          width: "100%", marginTop: 12, padding: "12px 14px", borderRadius: 12,
          display: "flex", justifyContent: "space-between", alignItems: "center",
          background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)",
          color: "inherit", font: "inherit", cursor: "pointer",
        }}
      >
        <span>{open ? "Hide" : "Show"} {newestFirst.length} closed trade{newestFirst.length === 1 ? "" : "s"}</span>
        <span aria-hidden="true" style={{ transform: open ? "rotate(180deg)" : "none", transition: "transform .2s" }}>▾</span>
      </button>

      {open && (newestFirst.length === 0 ? (
        <div className="empty-state">No completed trades yet.</div>
      ) : (
        newestFirst.map(({ t, balance }, i) => (
          <StatementRow key={`${t.ticker}-${t.entryTimestamp}-${i}`} t={t} runningBalance={balance} />
        ))
      ))}
    </div>
  );
}
