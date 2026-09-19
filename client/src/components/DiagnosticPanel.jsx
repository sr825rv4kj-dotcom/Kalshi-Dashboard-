import React, { useState } from "react";

function Row({ label, value, tone }) {
  return (
    <div className="trade-row">
      <span>{label}</span>
      <span className={tone || ""}>{String(value ?? "—")}</span>
    </div>
  );
}

export default function DiagnosticPanel({ apiBase }) {
  const [report, setReport] = useState(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);

  async function run() {
    setRunning(true); setError(null); setReport(null);
    try {
      const res = await fetch(`${apiBase}/api/diagnose/v2`);
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        // A non-JSON body means the server crashed and returned an HTML error
        // page. Show the first part of it rather than a parser message.
        throw new Error(`Server returned ${res.status}: ${text.slice(0, 200)}`);
      }
      if (data.error && !data.partial) throw new Error(data.error);
      setReport(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setRunning(false);
    }
  }

  const s = report?.stages || {};

  return (
    <div className="panel">
      <h2>Diagnostic</h2>
      <p className="setup-copy">
        Runs every stage of the trade path and reports the exact verdict at each
        one - which key is signing, what Kalshi returns, whether tickers resolve,
        the live price, and why the risk manager would take or skip the trade.
      </p>
      <button type="button" onClick={run} disabled={running}>
        {running ? "Running..." : "Run diagnostic scan"}
      </button>

      {error && <div className="error-banner" style={{ marginTop: 16 }}>{error}</div>}

      {report && (
        <div className="bot-subsection">
          <h3>Credentials</h3>
          <Row label="Key ID" value={s.credentials?.keyId} />
          <Row label="Key source" value={s.credentials?.source} />
          <Row label="Fingerprint" value={s.credentials?.fingerprint} />
          {s.credentials?.envVarAlsoSet && (
            <div className="trade-card-reason neg">
              KALSHI_PRIVATE_KEY_PEM is still set in Railway - delete it.
            </div>
          )}
          {s.credentials?.keyError && <div className="trade-card-reason neg">{s.credentials.keyError}</div>}

          <h3 style={{ marginTop: 16 }}>Kalshi</h3>
          <Row
            label="Reachable"
            value={s.kalshi?.ok ? "yes" : "no"}
            tone={s.kalshi?.ok ? "pos" : "neg"}
          />
          {s.kalshi?.ok
            ? <Row label="Balance" value={`$${(s.kalshi.balanceDollars ?? 0).toFixed(2)}`} />
            : <div className="trade-card-reason neg">{s.kalshi?.error}</div>}

          <h3 style={{ marginTop: 16 }}>Capital</h3>
          <Row label="Tradable" value={`$${(s.config?.tradableBankroll ?? 0).toFixed(2)}`} />
          <Row label="Reserved" value={`$${(s.config?.reserve ?? 0).toFixed(2)}`} />
          <Row label="Kelly fraction" value={s.config?.tier?.kellyFraction} />
          <Row label="Max stake" value={`$${s.config?.tier?.maxStakeDollars ?? "—"}`} />
          <Row label="Max concurrent" value={s.config?.tier?.maxConcurrentPositions} />
          <Row label="Open positions" value={s.config?.openPositions} />
          <Row label="Take profit" value={`${((s.config?.takeProfitPct ?? 0) * 100).toFixed(0)}%`} />
          <Row label="Trailing stop" value={`${((s.config?.trailingStopPct ?? 0) * 100).toFixed(0)}%`} />
          <Row label="Entry cross" value={`${s.config?.entrySlippageCents}c`} />

          {report.sports.map((sp) => (
            <div key={sp.sportKey} className="trade-card" style={{ marginTop: 16 }}>
              <div className="trade-card-team">{sp.sportKey}</div>

              {sp.odds?.ok ? (
                <>
                  <Row label="Odds provider" value={sp.odds.provider} />
                  <Row label="Teams with lines" value={sp.odds.teamsFound} tone={sp.odds.teamsFound ? "pos" : "neg"} />
                  <Row label="Quota left" value={sp.odds.quotaRemaining} />
                </>
              ) : (
                <div className="trade-card-reason neg">Odds failed: {sp.odds?.error}</div>
              )}

              {sp.kalshiFetch && (
                <div style={{ marginTop: 10 }}>
                  <Row label="Winning query" value={sp.kalshiFetch.winner} tone={sp.kalshiFetch.total ? "pos" : "neg"} />
                  <Row label="Markets returned" value={sp.kalshiFetch.total} />
                  <Row label="Statuses" value={JSON.stringify(sp.kalshiFetch.statuses)} />
                  <div className="trade-card-reason">
                    Tried: {sp.kalshiFetch.tried.map((t) => `${t.label}=${t.returned ?? t.error}`).join(", ")}
                  </div>
                </div>
              )}

              {sp.samples.map((sm, i) => (
                <div key={i} style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--panel-border)" }}>
                  <Row label="Team" value={sm.teamName} />
                  <Row label="Sharp prob" value={`${(sm.trueProbability * 100).toFixed(1)}%`} />
                  <Row label="Ticker" value={sm.ticker || "not resolved"} tone={sm.ticker ? "pos" : "neg"} />
                  {!sm.ticker && <div className="trade-card-reason">{sm.resolveReason}</div>}
                  {sm.yesAsk != null && (
                    <>
                      <Row label="Status" value={sm.marketStatus} />
                      <Row label="Yes ask" value={`${sm.yesAsk}c (${sm.yesAskSize} resting)`} />
                    </>
                  )}
                  {sm.verdict && (
                    <Row label="Verdict" value={sm.verdict} tone={sm.verdict === "candidate" ? "pos" : "neg"} />
                  )}
                  {sm.verdictReason && <div className="trade-card-reason neg">{sm.verdictReason}</div>}
                  {sm.edge && (
                    <Row
                      label="Edge vs required"
                      value={`${(sm.edge.observedEdge * 100).toFixed(2)}% vs ${(sm.edge.requiredEdge * 100).toFixed(2)}%`}
                      tone={sm.edge.qualifies ? "pos" : "neg"}
                    />
                  )}
                  {sm.sizing && <Row label="Would buy" value={`${sm.sizing.contracts} contracts ($${(sm.sizing.dollarsAtRisk ?? 0).toFixed(2)})`} />}
                  {sm.error && <div className="trade-card-reason neg">{sm.error}</div>}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
