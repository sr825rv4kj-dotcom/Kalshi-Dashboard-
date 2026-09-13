import React, { useEffect, useState } from "react";

function fmtDateTime(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

function fmtMoney(n) {
  if (n == null) return "—";
  return `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;
}

function Collapsible({ title, count, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="collapsible">
      <button type="button" className="collapsible-header" onClick={() => setOpen(!open)}>
        <span>{open ? "▾" : "▸"} {title}</span>
        <span className="collapsible-count">{count}</span>
      </button>
      {open && <div className="collapsible-body">{children}</div>}
    </div>
  );
}

function TradeCard({ trade }) {
  const isWin = trade.netDollars > 0;
  const score = trade.finalScore;

  return (
    <div className="trade-card">
      <div className="trade-card-top">
        <div>
          <div className="trade-card-team">{trade.teamName || trade.ticker}</div>
          <div className="trade-card-meta">{trade.sportKey || "—"} · {trade.ticker}</div>
        </div>
        {trade.status === "closed" && (
          <div className={`trade-card-roi ${isWin ? "pos" : "neg"}`}>
            {trade.roiPct != null ? `${trade.roiPct >= 0 ? "+" : ""}${trade.roiPct.toFixed(1)}%` : "—"}
          </div>
        )}
      </div>

      <div className="trade-card-rows">
        <div className="trade-row"><span>Entered</span><span>{fmtDateTime(trade.entryTimestamp || trade.timestamp)}</span></div>
        {trade.status === "closed" && (
          <div className="trade-row"><span>Exited</span><span>{fmtDateTime(trade.exitTimestamp)}</span></div>
        )}
        <div className="trade-row">
          <span>Contracts</span>
          <span>{trade.contracts} @ {trade.entryPriceCents ?? trade.priceCents}c</span>
        </div>
        <div className="trade-row"><span>Amount paid</span><span>{fmtMoney(trade.costDollars)}</span></div>
        {trade.status === "closed" && (
          <>
            <div className="trade-row"><span>Amount received</span><span>{fmtMoney(trade.proceedsDollars)}</span></div>
            <div className="trade-row">
              <span>Net P&amp;L</span>
              <span className={isWin ? "pos" : "neg"}>{fmtMoney(trade.netDollars)}</span>
            </div>
          </>
        )}
        {score && score.homeScore != null && (
          <div className="trade-row">
            <span>Final score</span>
            <span>{score.awayTeam} {score.awayScore} – {score.homeScore} {score.homeTeam}</span>
          </div>
        )}
        {trade.edgePct != null && (
          <div className="trade-row"><span>Edge at entry</span><span>{trade.edgePct.toFixed(1)}%</span></div>
        )}
      </div>

      <div className="trade-card-reason">
        <strong>Entry:</strong> {trade.entryReason || trade.reason || "—"}
      </div>
      {trade.exitReason && (
        <div className="trade-card-reason"><strong>Exit:</strong> {trade.exitReason}</div>
      )}
    </div>
  );
}

export default function TradeLedgerPanel({ apiBase }) {
  const [data, setData] = useState(null);
  const [withScores, setWithScores] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  async function refresh(fetchScores = withScores) {
    try {
      setError(null);
      const res = await fetch(`${apiBase}/api/trade-lifecycles${fetchScores ? "?withScores=true" : ""}`);
      const d = await res.json();
      if (d.error) throw new Error(d.error);
      setData(d);
    } catch (err) { setError(err.message); } finally { setLoading(false); }
  }

  useEffect(() => {
    refresh(false);
    const i = setInterval(() => refresh(), 30000);
    return () => clearInterval(i);
  }, []);

  if (loading) return <div className="panel"><h2>Trade History</h2><p className="muted">Loading...</p></div>;

  const completed = data?.completed ?? [];
  const open = data?.open ?? [];
  const stats = data?.stats ?? {};

  return (
    <div className="panel">
      <h2>Trade History</h2>
      <p className="setup-copy">
        Every figure below comes from real recorded fills - entry and exit prices, contract
        counts, and timestamps as they actually executed.
      </p>

      {error && <div className="error-banner">{error}</div>}

      <div className="bot-subsection" style={{ marginTop: 0, borderTop: "none", paddingTop: 0 }}>
        <div className="cost-row"><span>Win rate</span><span>{stats.winRatePct != null ? `${stats.winRatePct.toFixed(0)}% (${stats.wins}W / ${stats.losses}L)` : "—"}</span></div>
        <div className="cost-row"><span>Total net P&amp;L</span>
          <span className={stats.totalNetDollars > 0 ? "pos" : stats.totalNetDollars < 0 ? "neg" : ""}>
            {fmtMoney(stats.totalNetDollars)}
          </span>
        </div>
        <div className="cost-row"><span>Overall ROI</span>
          <span className={stats.overallRoiPct > 0 ? "pos" : stats.overallRoiPct < 0 ? "neg" : ""}>
            {stats.overallRoiPct != null ? `${stats.overallRoiPct >= 0 ? "+" : ""}${stats.overallRoiPct.toFixed(1)}%` : "—"}
          </span>
        </div>
      </div>

      <Collapsible title="Open positions" count={open.length} defaultOpen={open.length > 0}>
        {open.length === 0
          ? <div className="empty-state">No open positions. The bot has nothing live right now.</div>
          : open.map((t, i) => <TradeCard key={i} trade={t} />)}
      </Collapsible>

      <Collapsible title="Completed trades" count={completed.length}>
        {completed.length === 0
          ? <div className="empty-state">No completed trades yet.</div>
          : (
            <>
              {!withScores && (
                <button
                  type="button"
                  className="modal-cancel"
                  style={{ marginTop: 0, marginBottom: 12 }}
                  onClick={() => { setWithScores(true); refresh(true); }}
                >
                  Load final scores (uses extra odds-API credits)
                </button>
              )}
              {completed.map((t, i) => <TradeCard key={i} trade={t} />)}
            </>
          )}
      </Collapsible>
    </div>
  );
}
