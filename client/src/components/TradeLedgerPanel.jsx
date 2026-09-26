import React, { useEffect, useState } from "react";
import { teamIdentity, sportLabel, sportEmoji } from "../teamIdentity.js";

/** A contract price in cents shown as dollars: 42 -> "$0.42". */
function px(cents) {
  const n = Number(cents);
  return Number.isFinite(n) ? `$${(n / 100).toFixed(2)}` : "—";
}

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

/**
 * Works out both sides of the game and which one the bot held.
 * finalScore carries the real home/away names and scores from the odds
 * provider; teamName is the side actually bought. When scores have not been
 * fetched yet, the opponent is unknown and only the held side is shown.
 */
function gameSides(trade) {
  const fs = trade.finalScore;
  const held = (trade.teamName || "").toLowerCase();

  if (!fs || !fs.homeTeam) {
    return { sides: [{ name: trade.teamName, score: null, isHeld: true }], final: false };
  }

  const isHeldHome =
    fs.homeTeam.toLowerCase().includes(held) || held.includes(fs.homeTeam.toLowerCase());

  return {
    final: Boolean(fs.completed),
    sides: [
      { name: fs.awayTeam, score: fs.awayScore, isHeld: !isHeldHome },
      { name: fs.homeTeam, score: fs.homeScore, isHeld: isHeldHome },
    ],
  };
}

/** One side of a game: color bar, full name, final score, and the price paid. */
function SideRow({ name, sportKey, score, isHeld, priceCents }) {
  const id = teamIdentity(name, sportKey);
  return (
    <div className={`kx-side ${isHeld ? "kx-side-held" : ""}`} style={{ opacity: isHeld ? 1 : 0.62 }}>
      <span className="kx-side-swatch" style={{ background: id.primary, borderColor: id.secondary }} />
      <span className="kx-side-name">
        {id.name}
        {isHeld && <span className="kx-held-tag"> held</span>}
      </span>
      {score != null && <span className="kx-side-score">{score}</span>}
      {isHeld && priceCents != null && <span className="kx-pill">{px(priceCents)}</span>}
    </div>
  );
}

function ClosedCard({ t }) {
  const win = (t.netDollars ?? 0) > 0;
  const { sides, final } = gameSides(t);
  const title = sides.length > 1 ? `${sides[0].name} vs ${sides[1].name}` : t.teamName;

  return (
    <div className={`kx-card ${win ? "kx-card-win" : "kx-card-loss"}`}>
      <div className="kx-head">
        <div className="kx-tile">{sportEmoji(t.sportKey)}</div>
        <div className="kx-head-text">
          <div className="kx-title">{title}</div>
          <div className="kx-status">
            <span>{final ? "Final" : "Closed"}</span>
            <span className="kx-sep">·</span>
            <span>{sportLabel(t.sportKey)}</span>
            <span className="kx-sep">·</span>
            <span>{when(t.exitTimestamp)}</span>
          </div>
        </div>
      </div>

      {sides.map((s, i) => (
        <SideRow
          key={i}
          name={s.name}
          sportKey={t.sportKey}
          score={s.score}
          isHeld={s.isHeld}
          priceCents={t.entryPriceCents}
        />
      ))}

      <div className="kx-stats">
        <div><span>Entered</span><strong>{money(t.costDollars)}</strong></div>
        <div><span>Exited</span><strong>{money(t.proceedsDollars)}</strong></div>
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
        <span>In {px(t.entryPriceCents)} → Out {px(t.exitPriceCents)}</span>
        <span className="kx-sep">·</span>
        <span>{when(t.entryTimestamp)} → {when(t.exitTimestamp)}</span>
        {t.edgePct != null && (
          <>
            <span className="kx-sep">·</span>
            <span>edge {t.edgePct.toFixed(1)}% at entry</span>
          </>
        )}
      </div>

      <div className="kx-reason"><b>Why it entered:</b> {t.entryReason || "—"}</div>
      <div className="kx-reason"><b>Why it exited:</b> {t.exitReason || "—"}</div>
      <div className="kx-ticker">{t.ticker}</div>
    </div>
  );
}

function OpenCard({ t }) {
  const id = teamIdentity(t.teamName, t.sportKey);
  return (
    <div className="kx-card kx-card-open">
      <div className="kx-head">
        <div className="kx-tile">{sportEmoji(t.sportKey)}</div>
        <div className="kx-head-text">
          <div className="kx-title">{id.name}</div>
          <div className="kx-status">
            <span className="kx-dot" />
            <span className="kx-live">Open</span>
            <span className="kx-sep">·</span>
            <span>{sportLabel(t.sportKey)}</span>
          </div>
        </div>
      </div>

      <SideRow name={t.teamName} sportKey={t.sportKey} isHeld priceCents={t.priceCents} />

      <div className="kx-stats">
        <div><span>Entered</span><strong>{money(t.costDollars)}</strong></div>
        <div><span>Contracts</span><strong>{t.filled}</strong></div>
        <div><span>Entry</span><strong>{px(t.priceCents)}</strong></div>
        <div><span>Opened</span><strong>{when(t.timestamp)}</strong></div>
      </div>

      <div className="kx-reason"><b>Why it entered:</b> {t.reason || "—"}</div>
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
  const base = typeof apiBase === "string" && apiBase !== "undefined" ? apiBase : "";
  const [data, setData] = useState({ completed: [], open: [], stats: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  async function load() {
    try {
      setError(null);
      const res = await fetch(`${base}/api/trade-lifecycles?withScores=true`);
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
