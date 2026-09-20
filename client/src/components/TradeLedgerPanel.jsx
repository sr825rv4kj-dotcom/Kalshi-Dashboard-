import React, { useEffect, useState } from "react";
import { teamIdentity, sportLabel, sportEmoji } from "../teamIdentity.js";

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

/** One side of a game: color bar, full name, score, price pill. */
function SideRow({ name, sportKey, score, priceCents, held }) {
  const id = teamIdentity(name, sportKey);
  return (
    <div className={`kx-side ${held ? "kx-side-held" : ""}`}>
      <span className="kx-side-swatch" style={{ background: id.primary, borderColor: id.secondary }} />
      <span className="kx-side-name">{id.name}</span>
      {score != null && <span className="kx-side-score">{score}</span>}
      {priceCents != null && (
        <span className="kx-pill">{priceCents}¢</span>
      )}
    </div>
  );
}

/** The Kalshi-style card head: sport tile, matchup, status. */
function CardHead({ sportKey, title, status, live }) {
  return (
    <div className="kx-head">
      <div className="kx-tile">{sportEmoji(sportKey)}</div>
      <div className="kx-head-text">
        <div className="kx-title">{title}</div>
        <div className="kx-status">
          {live && <span className="kx-dot" />}
          <span className={live ? "kx-live" : ""}>{status}</span>
          <span className="kx-sep">·</span>
          <span>{sportLabel(sportKey)}</span>
        </div>
      </div>
    </div>
  );
}

function ClosedCard({ t }) {
  const win = (t.netDollars ?? 0) > 0;
  const opponent = t.opponentName || null;
  const title = opponent ? `${t.teamName} vs ${opponent}` : t.teamName;

  return (
    <div className={`kx-card ${win ? "kx-card-win" : "kx-card-loss"}`}>
      <CardHead
        sportKey={t.sportKey}
        title={title}
        status={t.finalScore ? "Final" : "Closed"}
        live={false}
      />

      <SideRow
        name={t.teamName}
        sportKey={t.sportKey}
        score={t.finalScore?.score}
        priceCents={t.entryPriceCents}
        held
      />
      {opponent && (
        <SideRow
          name={opponent}
          sportKey={t.sportKey}
          score={t.finalScore?.opponentScore}
          priceCents={null}
        />
      )}

      <div className="kx-stats">
        <div><span>Invested</span><strong>{money(t.costDollars)}</strong></div>
        <div><span>Returned</span><strong>{money(t.proceedsDollars)}</strong></div>
        <div>
          <span>{win ? "Won" : "Lost"}</span>
          <strong className={win ? "kx-pos" : "kx-neg"}>{money(t.netDollars)}</strong>
        </div>
        <div>
          <span>ROI</span>
          <strong className={win ? "kx-pos" : "kx-neg"}>
            {t.roiPct == null ? "—" : `${t.roiPct > 0 ? "+" : ""}${t.roiPct.toFixed(1)}%`}
          </strong>
        </div>
      </div>

      <div className="kx-meta">
        <span>{t.contracts} contracts</span>
        <span className="kx-sep">·</span>
        <span>In {t.entryPriceCents}¢ → Out {t.exitPriceCents}¢</span>
        <span className="kx-sep">·</span>
        <span>{when(t.entryTimestamp)} → {when(t.exitTimestamp)}</span>
      </div>

      <div className="kx-reason"><b>Entry:</b> {t.entryReason || "—"}</div>
      <div className="kx-reason"><b>Exit:</b> {t.exitReason || "—"}</div>
      <div className="kx-ticker">{t.ticker}</div>
    </div>
  );
}

function OpenCard({ t }) {
  return (
    <div className="kx-card kx-card-open">
      <CardHead sportKey={t.sportKey} title={t.teamName} status="Position open" live />

      <SideRow name={t.teamName} sportKey={t.sportKey} priceCents={t.priceCents} held />

      <div className="kx-stats">
        <div><span>Invested</span><strong>{money(t.costDollars)}</strong></div>
        <div><span>Contracts</span><strong>{t.filled}</strong></div>
        <div><span>Entry</span><strong>{t.priceCents}¢</strong></div>
        <div><span>Opened</span><strong>{when(t.timestamp)}</strong></div>
      </div>

      <div className="kx-reason"><b>Entry:</b> {t.reason || "—"}</div>
      <div className="kx-ticker">{t.ticker}</div>
    </div>
  );
}

function Section({ title, count, children, defaultOpen }) {
  const [open, setOpen] = useState(Boolean(defaultOpen));
  return (
    <div className="kx-section">
      <button type="button" className="kx-section-head" onClick={() => setOpen((v) => !v)}>
        <span>{title}</span>
        <span className="kx-count">{count}</span>
        <span className="kx-chevron">{open ? "▾" : "▸"}</span>
      </button>
      {open && <div>{children}</div>}
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
        <div className="kx-stats kx-summary">
          <div><span>Completed</span><strong>{s.totalExits}</strong></div>
          <div><span>Win rate</span><strong>{s.winRatePct == null ? "—" : `${s.winRatePct.toFixed(0)}%`}</strong></div>
          <div>
            <span>Net</span>
            <strong className={(s.totalNetDollars ?? 0) >= 0 ? "kx-pos" : "kx-neg"}>{money(s.totalNetDollars)}</strong>
          </div>
          <div>
            <span>Overall ROI</span>
            <strong className={(s.overallRoiPct ?? 0) >= 0 ? "kx-pos" : "kx-neg"}>
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

          <Section title="Completed trades" count={data.completed.length} defaultOpen>
            {data.completed.length === 0
              ? <div className="empty-state">No completed trades yet.</div>
              : data.completed.map((t, i) => <ClosedCard key={`${t.ticker}-${i}`} t={t} />)}
          </Section>
        </>
      )}
    </div>
  );
}
