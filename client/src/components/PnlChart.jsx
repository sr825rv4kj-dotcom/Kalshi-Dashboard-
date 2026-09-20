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
  const [trade, setTrade] = useState(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);

  /** Reads as text first so a crashed server shows its real error, not a parser message. */
  async function readJson(res) {
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Server returned ${res.status}: ${text.slice(0, 300)}`);
    }
  }

  async function runDiagnostic() {
    setRunning(true); setError(null); setReport(null); setTrade(null);
    try {
      const res = await fetch(`${apiBase}/api/diagnose/v2`);
      const data = await readJson(res);
      if (data.error && !data.partial) throw new Error(data.error);
      setReport(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setRunning(false);
    }
  }

  async function runTestTrade() {
    setRunning(true); setError(null); setReport(null); setTrade(null);
    try {
      const res = await fetch(`${apiBase}/api/test-trade`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contracts: 1, maxPriceCents: 95 }),
      });
      setTrade(await readJson(res));
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

      <button type="button" onClick={runDiagnostic} disabled={running}>
        {running ? "Working..." : "Run diagnostic scan"}
      </button>

      <button
        type="button"
        className="ledger-toggle"
        style={{ marginTop: 10 }}
        onClick={runTestTrade}
        disabled={running}
      >
        Place 1-contract test trade (real money)
      </button>
      <div className="ledger-reason" style={{ marginTop: 6 }}>
        Buys one YES contract at the ask on the first live market it can price,
        with no edge check. Up to about $0.95 plus fees. This proves whether
        orders reach the exchange.
      </div>

      {error && <div className="error-banner" style={{ marginTop: 16 }}>{error}</div>}

      {/* ---- Test trade result ---- */}
      {trade && (
        <div className="bot-subsection">
          <div className="ledger-card">
            <div className="ledger-card-head">
              <span>Test trade</span>
              <span className={trade.ok ? "pos" : "neg"}>{trade.ok ? "FILLED" : "NOT FILLED"}</span>
            </div>
            <Row label="Ticker" value={trade.ticker} />
            <Row label="Filled" value={trade.filled} tone={trade.filled ? "pos" : "neg"} />
            <Row label="Limit price" value={trade.limitCents != null ? `${trade.limitCents}c` : "—"} />
            {trade.error && <div className="trade-card-reason neg">{trade.error}</div>}
          </div>

          {(trade.steps ?? []).map((st, i) => (
            <div key={i} className="ledger-card">
              <div className="ledger-card-head">
                <span>{st.name}</span>
                <span className={st.error ? "neg" : ""}>{st.error ? "error" : "ok"}</span>
              </div>
              {st.error && <div className="trade-card-reason neg">{st.error}</div>}
              <pre
                style={{
                  whiteSpace: "pre-wrap", wordBreak: "break-word",
                  fontFamily: "ui-monospace, Menlo, monospace", fontSize: 11,
                  margin: "8px 0 0", opacity: 0.85,
                }}
              >
                {JSON.stringify(st, null, 1).slice(0, 1500)}
              </pre>
            </div>
          ))}
        </div>
      )}

      {/* ---- Diagnostic report ---- */}
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
          <Row label="Reachable" value={s.kalshi?.ok ? "yes" : "no"} tone={s.kalshi?.ok ? "pos" : "neg"} />
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

          {(report.sports ?? []).map((sp) => (
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
                </div>
              )}

              {(sp.samples ?? []).map((sm, i) => (
                <div key={i} style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--separator)" }}>
                  <Row label="Team" value={sm.teamName} />
                  <Row label="Sharp prob" value={`${(sm.trueProbability * 100).toFixed(1)}%`} />
                  <Row label="Ticker" value={sm.ticker || "not resolved"} tone={sm.ticker ? "pos" : "neg"} />
                  {!sm.ticker && <div className="trade-card-reason">{sm.resolveReason}</div>}
                  {sm.marketStatus && <Row label="Status" value={sm.marketStatus} />}
                  {sm.yesAsk != null && (
                    <>
                      <Row
                        label="Ask"
                        value={sm.yesAsk > 0 ? `${sm.yesAsk}c (${sm.yesAskSize} resting)` : "none"}
                        tone={sm.yesAsk > 0 ? "pos" : "neg"}
                      />
                      <Row label="Price source" value={sm.priceSource} />
                      <Row label="Book" value={`${sm.bookKeys} | ${sm.bookCounts}`} />
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
                  {sm.sizing && (
                    <Row label="Would buy" value={`${sm.sizing.contracts} contracts ($${(sm.sizing.dollarsAtRisk ?? 0).toFixed(2)})`} />
                  )}
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
