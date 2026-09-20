import React, { useState } from "react";

const TONE = { blocker: "neg", warn: "", ok: "pos" };
const ICON = { blocker: "⛔️", warn: "⚠️", ok: "✅" };

/**
 * The values that unblock trading at a small bankroll. These live in
 * bot-config.json on the Railway volume, not in the repo - which is why
 * editing code never changed them. Writing them through /api/bot/config is
 * the only thing that does.
 */
const RECOMMENDED = {
  maxRiskPctPerTrade: 0.10,      // 1% of $19.67 floors every order to zero
  minLiquidity: 0,               // relative 2x-coverage check governs instead
  maxConcurrentPositions: 3,     // 0 meant no position could ever open
  entryWindowHours: 0,           // trade live games at any point
  takeProfitPct: 0.15,           // must clear round-trip fees
  trailingStopPct: 0.08,
  exitBelowCost: false,          // fired on ordinary noise, paying fees each time
};

export default function SelfCheckPanel({ apiBase }) {
  const [report, setReport] = useState(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState(null);

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
    setApplying(true); setError(null); setApplied(null);
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
      setApplied("Settings applied. Restart the bot for the new limits to take effect on the next scan.");
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

      {report && (
        <button
          type="button"
          className="ledger-toggle"
          onClick={applyFixes}
          disabled={applying || running}
          style={{ marginTop: 10 }}
        >
          {applying ? "Applying..." : "Apply recommended settings"}
        </button>
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
