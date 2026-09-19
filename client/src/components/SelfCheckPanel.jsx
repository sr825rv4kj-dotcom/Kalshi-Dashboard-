import React, { useState } from "react";

const TONE = { blocker: "neg", warn: "", ok: "pos" };
const ICON = { blocker: "⛔️", warn: "⚠️", ok: "✅" };

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
          {report.summary && (
            <div className="ledger-figures ledger-summary">
              <div>
                <span>Blockers</span>
                <strong className={report.summary.blockers ? "neg" : "pos"}>{report.summary.blockers}</strong>
              </div>
              <div><span>Warnings</span><strong>{report.summary.warnings}</strong></div>
            </div>
          )}

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
