import React, { useEffect, useState } from "react";

/**
 * WHAT NEEDS IMPROVEMENT (2026-10-06).
 *
 * The app reads its own closed trades and says where it is losing, what it
 * tested instead (the other side of the same games, a different price range,
 * in-play vs pre-game, selling early) and which of those would have done
 * better. Every number is from the trade ledger - see server/src/improvementLab.js.
 * Read-only: nothing on this panel changes a setting.
 */

function resolveBase(apiBase) {
  if (typeof apiBase === "string" && apiBase && apiBase !== "undefined") return apiBase;
  const env = import.meta.env.VITE_API_BASE;
  if (typeof env === "string" && env && env !== "undefined") return env;
  return "";
}

function money(v) {
  const n = Number(v) || 0;
  return `${n < 0 ? "-" : "+"}$${Math.abs(n).toFixed(2)}`;
}
function pct(v) {
  if (v == null) return "—";
  return `${v >= 0 ? "+" : ""}${Number(v).toFixed(1)}%`;
}

const ACTION_LABEL = {
  "other-side": "BET OTHER SIDE",
  "price-range": "CHANGE PRICE RANGE",
  timing: "CHANGE TIMING",
  "sell-early": "SELL EARLY",
  pause: "PAUSE",
  watch: "WATCH",
};

function Row({ label, value, tone }) {
  return (
    <div className="trade-row">
      <span>{label}</span>
      <span className={tone || ""}>{String(value ?? "—")}</span>
    </div>
  );
}

function WeakArea({ w }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="ledger-card">
      <div className="ledger-card-head">
        <span>{w.area}</span>
        <span className={w.verdict?.action === "watch" ? "" : "neg"}>{ACTION_LABEL[w.verdict?.action] || "—"}</span>
      </div>
      <Row label="Result" value={`${money(w.net)} over ${w.trades} trade(s) (${pct(w.roiPct)})`} tone={w.net >= 0 ? "pos" : "neg"} />
      <Row label="Won vs prices implied" value={`${w.wins} of ${w.trades} vs ${w.expectedWins}`} />
      <Row label="Evidence" value={w.evidence} />
      <div className="trade-card-reason">{w.verdict?.text}</div>
      <button type="button" className="ledger-toggle" style={{ marginTop: 8 }} onClick={() => setOpen(!open)}>
        {open ? "Hide what was tested" : "Show what was tested"}
      </button>
      {open && (
        <div style={{ marginTop: 8 }}>
          {(w.alternatives || []).map((a) => (
            <div key={a.code} style={{ paddingTop: 8, marginTop: 8, borderTop: "1px solid var(--separator)" }}>
              <Row label={a.title} value={a.code === "pause" ? "$0.00" : `${money(a.net)} (${a.trades} trade(s))`} tone={a.net > 0 ? "pos" : a.net < 0 ? "neg" : ""} />
              <div className="ledger-reason">
                {a.note}
                {a.code === "other-side" && !w.flipBacked ? " - not recommended: this area wins about as often as its prices implied, so this is hindsight." : ""}
                {a.inSample ? " - in-sample." : ""}
              </div>
            </div>
          ))}
          {w.sellEarly && <div className="ledger-reason" style={{ marginTop: 8 }}>{w.sellEarly.text}</div>}
        </div>
      )}
    </div>
  );
}

export default function ImprovementsPanel({ apiBase }) {
  const base = resolveBase(apiBase);
  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [showAll, setShowAll] = useState(false);

  async function load() {
    setLoading(true); setError(null);
    try {
      const res = await fetch(`${base}/api/improvements`);
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { throw new Error(`Server returned ${res.status}: ${text.slice(0, 200)}`); }
      if (data.error) throw new Error(data.error);
      setReport(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  const weak = report?.weakAreas || [];

  return (
    <div className="panel">
      <h2>What Needs Improvement</h2>
      <p className="setup-copy">
        The bot reads every closed trade, finds where it loses, and tests other ways
        to play those same games - the other side, a different price range, in-play
        vs pre-game, selling early. Every number is from your real trades.
      </p>
      <button type="button" onClick={load} disabled={loading}>{loading ? "Reading trades..." : "Refresh"}</button>
      {error && <div className="error-banner" style={{ marginTop: 12 }}>{error}</div>}

      {report && (
        <>
          <div className="bot-subsection">
            <h3>Edge check</h3>
            <Row label="Closed trades" value={report.trades} />
            <Row label="Won vs prices implied" value={`${report.edge.wins} of ${report.edge.trades} vs ${report.edge.expectedWins}`} />
            <Row label="Net before fees" value={money(report.edge.netBeforeFees)} tone={report.edge.netBeforeFees >= 0 ? "pos" : "neg"} />
            <Row label="Fees paid" value={`$${Number(report.edge.fees || 0).toFixed(2)}`} />
            <Row label="Net after fees" value={`${money(report.edge.net)} (${pct(report.edge.roiPct)})`} tone={report.edge.net >= 0 ? "pos" : "neg"} />
            <Row label="Kalshi" value={`${money(report.byVenue.kalshi.net)} over ${report.byVenue.kalshi.trades} (${pct(report.byVenue.kalshi.roiPct)})`} tone={report.byVenue.kalshi.net >= 0 ? "pos" : "neg"} />
            <Row label="Polymarket" value={`${money(report.byVenue.polymarket.net)} over ${report.byVenue.polymarket.trades} (${pct(report.byVenue.polymarket.roiPct)})`} tone={report.byVenue.polymarket.net >= 0 ? "pos" : "neg"} />
            <div className="trade-card-reason">{report.edge.text}</div>
            {report.form && <div className="ledger-reason" style={{ marginTop: 6 }}>{report.form.text}</div>}
          </div>

          <div className="bot-subsection">
            <h3>Needs improvement</h3>
            {report.needsImprovement.length === 0 && <div className="empty-state">Nothing losing with enough trades to judge.</div>}
            {report.needsImprovement.map((n) => (
              <div key={n.priority} className="ledger-card">
                <div className="ledger-card-head">
                  <span>{n.priority}. {n.title}</span>
                </div>
                {n.evidence && <Row label="Evidence" value={n.evidence} />}
                <div className="trade-card-reason">{n.text}</div>
              </div>
            ))}
          </div>

          <div className="bot-subsection">
            <h3>Losing areas - what was tested</h3>
            {weak.length === 0 && <div className="empty-state">No losing area with 6+ trades.</div>}
            {(showAll ? weak : weak.slice(0, 5)).map((w) => <WeakArea key={w.area} w={w} />)}
            {weak.length > 5 && (
              <button type="button" className="ledger-toggle" onClick={() => setShowAll(!showAll)}>
                {showAll ? "Show fewer" : `Show all ${weak.length}`}
              </button>
            )}
          </div>

          <div className="bot-subsection">
            <h3>Working - keep doing</h3>
            {(report.working || []).length === 0 && <div className="empty-state">Nothing is clearly beating its prices yet.</div>}
            {(report.working || []).map((w) => (
              <div key={w.area} className="trade-row">
                <span>{w.area}</span>
                <span className="pos">{money(w.net)} · {w.wins}/{w.trades} vs {w.expectedWins}</span>
              </div>
            ))}
          </div>

          {report.polymarket && (
            <div className="bot-subsection">
              <h3>Polymarket</h3>
              {report.polymarket.lines.map((l, i) => <div key={i} className="ledger-reason" style={{ marginTop: 6 }}>{l}</div>)}
            </div>
          )}

          <div className="ledger-reason" style={{ marginTop: 12 }}>{report.method}</div>
        </>
      )}
    </div>
  );
}
