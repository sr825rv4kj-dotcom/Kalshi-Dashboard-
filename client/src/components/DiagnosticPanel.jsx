import React, { useState } from "react";

export default function DiagnosticPanel({ apiBase }) {
  const [report, setReport] = useState(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);

  async function run() {
    setRunning(true); setError(null); setReport(null);
    try {
      const res = await fetch(`${apiBase}/api/diagnose`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setReport(data);
    } catch (err) { setError(err.message); } finally { setRunning(false); }
  }

  return (
    <div className="panel">
      <h2>Diagnostic</h2>
      <p className="setup-copy">
        Runs one scan now and reports what happened at each step - odds fetched,
        teams returned, tickers resolved, market prices found.
      </p>
      <button type="button" onClick={run} disabled={running}>
        {running ? "Running scan..." : "Run diagnostic scan"}
      </button>

      {error && <div className="error-banner" style={{ marginTop: 16 }}>{error}</div>}

      {report && (
        <div className="bot-subsection">
          <div className="cost-row">
            <span>Entry window</span>
            <span>{report.config?.entryWindowHours ? `${report.config.entryWindowHours}h` : "OFF (live allowed)"}</span>
          </div>
          <div className="cost-row"><span>Min entry price</span><span>{report.config?.minEntryPriceCents}c</span></div>
          <div className="cost-row"><span>Active sports</span><span>{report.activeSports?.length ?? 0}</span></div>

          {(report.sports ?? []).map((s) => (
            <div key={s.sportKey} className="trade-card" style={{ marginTop: 12 }}>
              <div className="trade-card-team">{s.sportKey}</div>
              {s.oddsError ? (
                <div className="trade-card-reason neg">Odds failed: {s.oddsError}</div>
              ) : (
                <>
                  <div className="trade-row"><span>Provider</span><span>{s.provider}</span></div>
                  <div className="trade-row">
                    <span>Teams with lines</span>
                    <span className={s.teamsFound ? "pos" : "neg"}>{s.teamsFound}</span>
                  </div>
                  {(s.samples ?? []).map((sm, i) => (
                    <div key={i} style={{ marginTop: 10, paddingTop: 10, borderTop: "0.5px solid var(--separator)" }}>
                      <div className="trade-row"><span>Team</span><span>{sm.teamName}</span></div>
                      <div className="trade-row">
                        <span>Ticker</span>
                        <span className={sm.ticker ? "pos" : "neg"}>{sm.ticker || "not resolved"}</span>
                      </div>
                      {!sm.ticker && <div className="trade-card-reason">{sm.resolveReason}</div>}
                      {sm.yesAsk != null && (
                        <div className="trade-row"><span>Yes ask</span><span>{sm.yesAsk}c</span></div>
                      )}
                    </div>
                  ))}
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
