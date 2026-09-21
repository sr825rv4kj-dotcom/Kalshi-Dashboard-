import React, { useState } from "react";

/**
 * Per-sport coverage walk.
 *
 * "0 trades entered" is produced identically by a healthy sport with no
 * mispricing, a sport whose Kalshi series was never found, a sport whose team
 * names do not resolve, and a sport that crashed. This panel tells them apart
 * by naming the exact stage that failed, per sport.
 *
 * READ IT THIS WAY:
 *   Working   - the pipeline reaches the order book. If it also says "none
 *               show an edge", that is a FAIR MARKET, not a fault.
 *   No games  - nothing scheduled. Out of season or the slate is done.
 *   Blocked   - a stage failed. The stage is named. That is the thing to fix.
 *
 * Each run spends one odds credit per sport, so it is a button, not a timer.
 */

const VERDICT = {
  ready:      { icon: "✅", label: "Working",  tone: "pos" },
  "no-games": { icon: "💤", label: "No games", tone: "" },
  blocked:    { icon: "⛔️", label: "Blocked",  tone: "neg" },
  unknown:    { icon: "❔", label: "Unknown",  tone: "" },
};

const STAGE_ORDER = ["series", "model", "odds", "timing", "resolve", "market", "price", "gate"];

function prettySport(key) {
  return String(key)
    .replace(/^americanfootball_/, "")
    .replace(/^basketball_/, "")
    .replace(/^baseball_/, "")
    .replace(/^icehockey_/, "")
    .replace(/^soccer_/, "")
    .replace(/^tennis_/, "tennis ")
    .replace(/_/g, " ")
    .toUpperCase();
}

export default function CoveragePanel({ apiBase }) {
  const [report, setReport] = useState(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState({});
  const [wide, setWide] = useState(false);

  async function run(discovered) {
    setRunning(true); setError(null); setReport(null);
    try {
      const qs = discovered ? "?discovered=true&sample=4" : "?sample=6";
      const res = await fetch(`${apiBase}/api/coverage${qs}`);
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); }
      catch { throw new Error(`Server returned ${res.status}: ${text.slice(0, 200)}`); }
      if (data.error) throw new Error(data.error);
      setReport(data);
      setWide(!!discovered);
    } catch (err) {
      setError(err.message);
    } finally {
      setRunning(false);
    }
  }

  const s = report?.summary;

  return (
    <div className="panel">
      <h2>Sport Coverage</h2>
      <p className="setup-copy">
        Walks every sport through the real pipeline — Kalshi series, odds feed,
        ticker resolution, market status, order book, entry gate — and names the
        first stage that fails. Costs one odds credit per sport, so it only runs
        when you tap it.
      </p>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <button type="button" onClick={() => run(false)} disabled={running}>
          {running ? "Walking…" : "Check the 12 core sports"}
        </button>
        <button
          type="button"
          className="ledger-toggle"
          onClick={() => run(true)}
          disabled={running}
        >
          Check everything live
        </button>
      </div>

      {error && <div className="error-banner" style={{ marginTop: 16 }}>{error}</div>}

      {report && (
        <div className="bot-subsection">
          <div className="ledger-figures ledger-summary">
            <div><span>Working</span><strong className="pos">{s.ready}</strong></div>
            <div><span>No games</span><strong>{s.noGames}</strong></div>
            <div><span>Blocked</span><strong className={s.blocked ? "neg" : "pos"}>{s.blocked}</strong></div>
            <div><span>Entry-ready now</span><strong className={s.wouldEnterNow ? "pos" : ""}>{s.wouldEnterNow}</strong></div>
          </div>

          <div className="ledger-reason" style={{ marginTop: 8 }}>
            {report.sports.length} sport(s){wide ? " (core + everything the feed reports live)" : ""} ·
            {" "}{report.oddsCallsUsed} odds credit(s) spent · scanner {report.scannerVersion}
          </div>

          {report.sports.map((row) => {
            const v = VERDICT[row.verdict] || VERDICT.unknown;
            const isOpen = !!open[row.sportKey];
            return (
              <div key={row.sportKey} className="ledger-card">
                <div
                  className="ledger-card-head"
                  onClick={() => setOpen((o) => ({ ...o, [row.sportKey]: !o[row.sportKey] }))}
                  style={{ cursor: "pointer" }}
                >
                  <span>{v.icon} {prettySport(row.sportKey)}</span>
                  <span className={v.tone}>{v.label}{row.blockedAt ? ` · ${row.blockedAt}` : ""}</span>
                </div>

                <div style={{ marginTop: 8, fontSize: 15, lineHeight: 1.45 }}>{row.headline}</div>

                {!isOpen && (
                  <div className="ledger-reason" style={{ marginTop: 6 }}>
                    Tap for the stage-by-stage walk.
                  </div>
                )}

                {isOpen && (
                  <div style={{ marginTop: 12 }}>
                    {STAGE_ORDER.map((name) => {
                      const st = (row.stages || []).find((x) => x.stage === name);
                      if (!st) return null;
                      return (
                        <div key={name} style={{ display: "flex", gap: 8, padding: "5px 0", fontSize: 14, lineHeight: 1.4 }}>
                          <span style={{ flex: "0 0 18px" }}>{st.ok ? "✅" : "⛔️"}</span>
                          <span style={{ flex: "0 0 108px", opacity: 0.75 }}>{st.label}</span>
                          <span style={{ flex: 1 }}>{st.detail}</span>
                        </div>
                      );
                    })}

                    {!!(row.samples || []).length && (
                      <div style={{ marginTop: 12 }}>
                        <div className="ledger-reason"><strong>Markets sampled</strong></div>
                        {row.samples.map((sm, i) => (
                          <div key={i} style={{ padding: "5px 0", fontSize: 14, lineHeight: 1.4 }}>
                            <div>
                              {sm.live ? "🔴 LIVE " : ""}{sm.teamName}
                              {sm.sharpPct != null ? ` — sharp ${sm.sharpPct}%` : ""}
                              {sm.askCents ? ` vs ${sm.askCents}c ask` : ""}
                              {sm.spreadCents != null ? ` (${sm.spreadCents}c spread)` : ""}
                            </div>
                            <div className="ledger-reason">
                              {sm.ticker || "unresolved"}
                              {sm.status ? ` · ${sm.status}` : ""}
                              {sm.gate ? ` · gate: ${sm.gate}` : ""}
                              {sm.failedAt ? ` · failed at ${sm.failedAt}` : ""}
                              {sm.note ? ` — ${sm.note}` : ""}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
