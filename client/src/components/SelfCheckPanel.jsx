import React, { useState } from "react";

const TONE = { blocker: "neg", warn: "", ok: "pos" };
const ICON = { blocker: "⛔️", warn: "⚠️", ok: "✅" };

/**
 * Settings the "Apply" button writes through /api/bot/config.
 *
 * This block used to push the OPPOSITE of the current strategy. It set
 * entryWindowHours to 0 ("trade live games at any point"), takeProfitPct to
 * 0.15 and trailingStopPct to 0.08 - which is precisely the behaviour that was
 * measured at -1.92c per contract and removed. One tap would have quietly
 * reverted the whole strategy change while reporting success.
 *
 * It now matches the shipped defaults in configStore.js. Keep the two in step:
 * if a default changes there, change it here as well, or this button becomes a
 * way to silently drift the running bot away from the tested configuration.
 */
const RECOMMENDED = {
  // What may be traded
  allowLiveGames: false,        // a pre-game line cannot price a live market
  holdToSettlement: true,       // settlement is free; a flip pays a second fee
  entryWindowHours: 8,
  minMinutesBeforeStart: 0,

  // Price band - below 25c the whole-cent fee dominates the stake
  minEntryPriceCents: 25,
  maxEntryPriceCents: 88,
  maxPlausibleEdge: 0.18,
  minEvCentsPerContract: 2,
  maxSpreadCents: 6,
  minLiquidity: 0,              // coverage is checked against order size instead

  // Sizing
  kellyFraction: 0.25,
  maxRiskPctPerTrade: 0.20,

  // Exits: the three nulls are deliberate, not missing. Each cost more in
  // fees than it ever saved in price.
  perPositionStopLossPct: null,
  takeProfitPct: null,
  trailingStopPct: null,
  exitBelowCost: false,         // the bid is ALWAYS below entry right after buying
  blowoutExitBelowCents: 12,
  blowoutExitCollapsePct: 0.6,

  reentryCooldownMinutes: 60,
  dailyLossHaltPct: 0.15,
};

export default function SelfCheckPanel({ apiBase }) {
  const [report, setReport] = useState(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState(null);
  const [confirming, setConfirming] = useState(false);

  async function run() {
    setRunning(true); setError(null); setReport(null); setApplied(null);
    try {
      const res = await fetch(`${apiBase}/api/selfcheck`);
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); }
      catch { throw new Error(`Server returned ${res.status}: ${text.slice(0, 200)}`); }
      if (data.error && !data.partial) throw new Error(data.error);
      setReport(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setRunning(false);
    }
  }

  async function applyFixes() {
    setApplying(true); setError(null); setApplied(null); setConfirming(false);
    try {
      const res = await fetch(`${apiBase}/api/bot/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(RECOMMENDED),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setApplied("Settings written. Re-running check...");
      await run();
      setApplied("Tested defaults applied. Restart the bot so the next scan picks them up.");
    } catch (err) {
      setError(err.message);
    } finally {
      setApplying(false);
    }
  }

  const blockers = report?.summary?.blockers ?? 0;

  return (
    <div className="panel">
      <h2>System Check</h2>
      <p className="setup-copy">
        Audits the running code against itself - missing exports, stale files,
        and any config value that makes trading arithmetically impossible.
      </p>

      <button type="button" onClick={run} disabled={running || applying}>
        {running ? "Checking..." : "Run system check"}
      </button>

      {report && !confirming && (
        <button
          type="button"
          className="ledger-toggle"
          onClick={() => setConfirming(true)}
          disabled={applying || running}
          style={{ marginTop: 10 }}
        >
          Reset to tested defaults
        </button>
      )}

      {confirming && (
        <div className="error-banner" style={{ marginTop: 12 }}>
          This overwrites the live strategy settings with the tested defaults:
          pre-game entries only, held to settlement, 25-88c price band, 25% Kelly.
          Anything you have tuned by hand will be replaced.
          <div className="error-action" style={{ display: "flex", gap: 10 }}>
            <button type="button" onClick={applyFixes} disabled={applying}>
              {applying ? "Applying..." : "Yes, reset"}
            </button>
            <button type="button" className="modal-cancel" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {applied && <div className="ledger-reason" style={{ marginTop: 10 }}>{applied}</div>}
      {error && <div className="error-banner" style={{ marginTop: 16 }}>{error}</div>}

      {report && (
        <div className="bot-subsection">
          <div className="ledger-figures ledger-summary">
            <div>
              <span>Blockers</span>
              <strong className={blockers ? "neg" : "pos"}>{blockers}</strong>
            </div>
            <div><span>Warnings</span><strong>{report.summary?.warnings ?? 0}</strong></div>
          </div>

          {report.findings.map((f, i) => (
            <div key={i} className="ledger-card">
              <div className="ledger-card-head">
                <span>{ICON[f.level]} {f.area}</span>
                <span className={TONE[f.level]}>{f.level}</span>
              </div>
              <div style={{ marginTop: 8, fontSize: 15, lineHeight: 1.45 }}>{f.detail}</div>
              <div className="ledger-reason"><strong>Fix:</strong> {f.fix}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
