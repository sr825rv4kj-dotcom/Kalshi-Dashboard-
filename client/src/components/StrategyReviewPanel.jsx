import React, { useEffect, useState } from "react";

/**
 * Strategy Review.
 *
 * Reads back what the bot actually did and groups it by the things the
 * strategy has knobs for. Every decision about thresholds up to now has been
 * argument; this makes it arithmetic.
 *
 * Sample size is shown beside every row and anything thin is marked, because
 * the failure mode here is not a missing number - it is acting on ten trades
 * as though they were a hundred.
 */

const GROUPS = [
  { key: "byExitFamily", title: "Holding vs bailing", hint: "Settlement is free. Every early exit pays a fee and crosses the spread." },
  { key: "byTiming", title: "In-play vs pre-game", hint: "Whether the live corroboration gate is pulling its weight." },
  { key: "byPriceBand", title: "Entry price", hint: "The whole-cent fee is a far bigger share of a cheap contract." },
  { key: "byEdgeBand", title: "Edge at entry", hint: "Whether a bigger claimed edge actually produces a better result." },
  { key: "byExitReason", title: "Exit reason", hint: "Which exit rules earn their keep." },
  { key: "bySport", title: "Sport", hint: null },
];

function pct(v) {
  if (v == null) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
}
function money(v) {
  const n = Number(v) || 0;
  return `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;
}

function BucketTable({ rows, minSample }) {
  if (!rows || !rows.length) return <div className="empty-state">No trades in this grouping yet.</div>;
  return (
    <div className="sr-table">
      <div className="sr-row sr-head">
        <span>Bucket</span><span>N</span><span>W/L</span><span>Net</span><span>ROI</span>
      </div>
      {rows.map((b) => (
        <div key={b.label} className={`sr-row ${b.actionable ? "" : "sr-thin"}`}>
          <span className="sr-label">
            {b.label}
            {!b.actionable && <em className="sr-flag">under {minSample}</em>}
          </span>
          <span>{b.n}</span>
          <span>{b.wins}/{b.losses}</span>
          <span className={b.net >= 0 ? "pos" : "neg"}>{money(b.net)}</span>
          <span className={(b.roiPct ?? 0) >= 0 ? "pos" : "neg"}>{pct(b.roiPct)}</span>
        </div>
      ))}
    </div>
  );
}

export default function StrategyReviewPanel({ apiBase }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [openGroup, setOpenGroup] = useState("byExitFamily");

  async function load() {
    setBusy(true); setError(null);
    try {
      const res = await fetch(`${apiBase}/api/strategy-review`);
      const text = await res.text();
      let json;
      try { json = JSON.parse(text); }
      catch { throw new Error(`Server returned ${res.status}: ${text.slice(0, 160)}`); }
      if (json.error) throw new Error(json.error);
      setData(json);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { load(); }, []);

  return (
    <div className="panel">
      <h2>Strategy Review</h2>
      <p className="setup-copy">
        What the bot actually did, grouped by the settings you can change.
        Thresholds get tuned from this rather than from a hunch.
      </p>

      <button type="button" onClick={load} disabled={busy}>
        {busy ? "Reading ledger..." : "Refresh review"}
      </button>

      {error && <div className="error-banner" style={{ marginTop: 14 }}>{error}</div>}

      {data?.lastScan && (
        <div className="bot-subsection">
          <div className="field-label">Why it is not trading right now</div>
          <div className="sr-scan-head">
            Last scan saw <strong>{data.lastScan.seen}</strong> line(s) across{" "}
            <strong>{data.lastScan.sports}</strong> sport(s) and entered{" "}
            <strong className={data.lastScan.entered ? "pos" : "neg"}>{data.lastScan.entered}</strong>.
          </div>
          {data.lastScan.blockers.length === 0 ? (
            <div className="empty-state">Nothing was refused - the bot is taking everything that qualifies.</div>
          ) : (
            <div className="sr-table">
              {data.lastScan.blockers.map((b) => (
                <div key={b.code} className="sr-blocker">
                  <span className="sr-blocker-n">{b.count}</span>
                  <span className="sr-blocker-label">{b.label}</span>
                </div>
              ))}
            </div>
          )}
          <div className="sr-hint">
            The top row is the gate doing the most blocking. If it is a threshold
            you set, that is the one to loosen.
          </div>
        </div>
      )}

      {data && (
        <>
          <div className="sr-summary">
            <div><span>Completed</span><strong>{data.overall.n}</strong></div>
            <div><span>Net</span><strong className={data.overall.net >= 0 ? "pos" : "neg"}>{money(data.overall.net)}</strong></div>
            <div><span>ROI</span><strong className={(data.overall.roiPct ?? 0) >= 0 ? "pos" : "neg"}>{pct(data.overall.roiPct)}</strong></div>
            <div><span>Open</span><strong>{data.open.count} · {money(data.open.exposureDollars)}</strong></div>
          </div>

          {data.observations?.length > 0 && (
            <div className="bot-subsection">
              <div className="field-label">What the numbers say</div>
              {data.observations.map((o, i) => (
                <div key={i} className={`sr-note sr-note-${o.strength}`}>
                  <span className="sr-note-tag">{o.strength}</span>
                  {o.text}
                </div>
              ))}
            </div>
          )}

          <div className="bot-subsection">
            {GROUPS.map((g) => {
              const rows = data[g.key];
              const isOpen = openGroup === g.key;
              return (
                <div key={g.key} className="sr-group">
                  <button
                    type="button"
                    className="sr-group-head"
                    onClick={() => setOpenGroup(isOpen ? null : g.key)}
                  >
                    <span>{g.title}</span>
                    <span className="kx-chevron">{isOpen ? "▾" : "▸"}</span>
                  </button>
                  {isOpen && (
                    <>
                      {g.hint && <div className="sr-hint">{g.hint}</div>}
                      <BucketTable rows={rows} minSample={data.minSample} />
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
