import React, { useState } from "react";

const TONE = { blocker: "neg", warn: "", ok: "pos" };
const ICON = { blocker: "⛔️", warn: "⚠️", ok: "✅" };

/**
 * System check - read only.
 *
 * "RESET TO TESTED DEFAULTS" REMOVED (2026-09-28). That button wrote a fixed
 * block of settings that no longer matched the strategy: allowLiveGames:
 * false (which switches live trading OFF - the bot trades live games only),
 * an 8-hour pre-game window, a 6c spread limit and a 25-88c band. One tap
 * would have stopped every trade on both exchanges while reporting success.
 * Settings are changed in Bot Settings, one value at a time, where each is
 * visible.
 */

export default function SelfCheckPanel({ apiBase }) {
  const [report, setReport] = useState(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);

  async function run() {
    setRunning(true); setError(null); setReport(null);
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

  const blockers = report?.summary?.blockers ?? 0;

  return (
    <div className="panel">
      <h2>System Check</h2>
      <p className="setup-copy">
        Audits the running code against itself - missing exports, stale files,
        and any config value that makes trading arithmetically impossible.
      </p>

      <button type="button" onClick={run} disabled={running}>
        {running ? "Checking..." : "Run system check"}
      </button>

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
