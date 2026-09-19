import React, { useEffect, useState } from "react";
import { teamIdentity, sportLabel } from "../teamIdentity.js";

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

/** The identity chip: large sport emoji, team colors, full name, final score. */
function TeamChip({ name, sportKey, score, muted }) {
  const id = teamIdentity(name, sportKey);
  return (
    <div className="team-chip" style={{ opacity: muted ? 0.62 : 1 }}>
      <div
        className="team-chip-badge"
        style={{ background: id.primary, borderColor: id.secondary, color: id.secondary }}
      >
        <span className="team-chip-emoji">{id.emoji}</span>
      </div>
      <div className="team-chip-body">
        <div className="team-chip-name">{id.name}</div>
        <div className="team-chip-stripe">
          <span style={{ background: id.primary }} />
          <span style={{ background: id.secondary }} />
        </div>
      </div>
      {score != null && <div className="team-chip-score">{score}</div>}
    </div>
  );
}

function TradeCard({ t }) {
  const [showDetail, setShowDetail] = useState(false);
  const win = (t.netDollars ?? 0) > 0;
  const opponent = t.opponentName || null;

  return (
    <div className="ledger-card">
      <div className="ledger-card-head">
        <span className="ledger-sport">{sportLabel(t.sportKey)}</span>
        <span className="ledger-when">{when(t.entryTimestamp)}</span>
      </div>

      <TeamChip name={t.teamName} sportKey={t.sportKey} score={t.finalScore?.score} />
      {opponent && (
        <>
          <div className="ledger-vs">vs</div>
          <TeamChip name={opponent} sportKey={t.sportKey} score={t.finalScore?.opponentScore} muted />
        </>
      )}

      <div className="ledger-figures">
        <div><span>Invested</span><strong>{money(t.costDollars)}</strong></div>
        <div><span>Returned</span><strong>{money(t.proceedsDollars)}</strong></div>
        <div>
          <span>{win ? "Won" : "Lost"}</span>
          <strong className={win ? "pos" : "neg"}>{money(t.netDollars)}</strong>
        </div>
        <div>
          <span>ROI</span>
          <strong className={win ? "pos" : "neg"}>
            {t.roiPct == null ? "—" : `${t.roiPct > 0 ? "+" : ""}${t.roiPct.toFixed(1)}%`}
          </strong>
        </div>
      </div>

      <button type="button" className="ledger-toggle" onClick={() => setShowDetail((v) => !v)}>
        {showDetail ? "Hide details" : "Details"}
      </button>

      {showDetail && (
        <div className="ledger-detail">
          <div className="trade-row"><span>Ticker</span><span className="mono">{t.ticker}</span></div>
          <div className="trade-row"><span>Contracts</span><span>{t.contracts}</span></div>
          <div className="trade-row"><span>Entry</span><span>{t.entryPriceCents}c · {when(t.entryTimestamp)}</span></div>
          <div className="trade-row"><span>Close</span><span>{t.exitPriceCents}c · {when(t.exitTimestamp)}</span></div>
          <div className="trade-row"><span>Edge at entry</span><span>{t.edgePct == null ? "—" : `${t.edgePct.toFixed(1)}%`}</span></div>
          <div className="ledger-reason"><strong>Why it entered:</strong> {t.entryReason || "—"}</div>
          <div className="ledger-reason"><strong>Why it closed:</strong> {t.exitReason || "—"}</div>
        </div>
      )}
    </div>
  );
}

function OpenCard({ t }) {
  const [showDetail, setShowDetail] = useState(false);
  return (
    <div className="ledger-card">
      <div className="ledger-card-head">
        <span className="ledger-sport">{sportLabel(t.sportKey)}</span>
        <span className="ledger-live">OPEN</span>
      </div>
      <TeamChip name={t.teamName} sportKey={t.sportKey} />
      <div className="ledger-figures">
        <div><span>Invested</span><strong>{money(t.costDollars)}</strong></div>
        <div><span>Contracts</span><strong>{t.filled}</strong></div>
        <div><span>Entry</span><strong>{t.priceCents}c</strong></div>
        <div><span>Opened</span><strong>{when(t.timestamp)}</strong></div>
      </div>
      <button type="button" className="ledger-toggle" onClick={() => setShowDetail((v) => !v)}>
        {showDetail ? "Hide details" : "Details"}
      </button>
      {showDetail && (
        <div className="ledger-detail">
          <div className="trade-row"><span>Ticker</span><span className="mono">{t.ticker}</span></div>
          <div className="ledger-reason"><strong>Why it entered:</strong> {t.reason || "—"}</div>
        </div>
      )}
    </div>
  );
}

function Section({ title, count, children, defaultOpen }) {
  const [open, setOpen] = useState(Boolean(defaultOpen));
  return (
    <div className="ledger-section">
      <button type="button" className="ledger-section-head" onClick={() => setOpen((v) => !v)}>
        <span>{title}</span>
        <span className="ledger-count">{count}</span>
        <span className="ledger-chevron">{open ? "▾" : "▸"}</span>
      </button>
      {open && <div className="ledger-section-body">{children}</div>}
    </div>
  );
}

export default function TradeLedgerPanel({ apiBase }) {
  const [data, setData] = useState({ completed: [], open: [], stats: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  async function load() {
    try {
      setError(null);
      const res = await fetch(`${apiBase}/api/trade-lifecycles?withScores=true`);
      const json = await res.json();
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

  const s = data.stats;

  return (
    <div className="panel">
      <h2>Trade Log</h2>

      {s && (
        <div className="ledger-figures ledger-summary">
          <div><span>Completed</span><strong>{s.totalExits}</strong></div>
          <div><span>Win rate</span><strong>{s.winRatePct == null ? "—" : `${s.winRatePct.toFixed(0)}%`}</strong></div>
          <div>
            <span>Net</span>
            <strong className={(s.totalNetDollars ?? 0) >= 0 ? "pos" : "neg"}>{money(s.totalNetDollars)}</strong>
          </div>
          <div>
            <span>Overall ROI</span>
            <strong className={(s.overallRoiPct ?? 0) >= 0 ? "pos" : "neg"}>
              {s.overallRoiPct == null ? "—" : `${s.overallRoiPct.toFixed(1)}%`}
            </strong>
          </div>
        </div>
      )}

      {loading && <p className="muted">Loading trades...</p>}
      {error && <div className="error-banner">{error}</div>}

      {!loading && !error && (
        <>
          <Section title="Open positions" count={data.open.length} defaultOpen>
            {data.open.length === 0
              ? <div className="empty-state">No open positions.</div>
              : data.open.map((t, i) => <OpenCard key={`${t.ticker}-${i}`} t={t} />)}
          </Section>

          <Section title="Completed trades" count={data.completed.length}>
            {data.completed.length === 0
              ? <div className="empty-state">No completed trades yet.</div>
              : data.completed.map((t, i) => <TradeCard key={`${t.ticker}-${i}`} t={t} />)}
          </Section>
        </>
      )}
    </div>
  );
}
