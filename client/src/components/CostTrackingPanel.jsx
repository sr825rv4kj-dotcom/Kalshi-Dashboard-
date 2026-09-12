import React, { useEffect, useState } from "react";

export default function CostTrackingPanel({ apiBase }) {
  const [costs, setCosts] = useState({ hosting: "", oddsApi: "", other: "" });
  const [currentBalance, setCurrentBalance] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [savedMessage, setSavedMessage] = useState(null);

  async function refresh() {
    try {
      const res = await fetch(`${apiBase}/api/milestones`);
      const d = await res.json();
      if (d.error) throw new Error(d.error);
      setCurrentBalance(d.currentBalance);
      if (d.monthlyCosts) {
        setCosts({
          hosting: d.monthlyCosts.hosting ?? 0,
          oddsApi: d.monthlyCosts.oddsApi ?? 0,
          other: d.monthlyCosts.other ?? 0,
        });
      }
    } catch (err) { setError(err.message); }
  }
  useEffect(() => { refresh(); }, []);

  const total = (Number(costs.hosting) || 0) + (Number(costs.oddsApi) || 0) + (Number(costs.other) || 0);
  const monthsOfCoverage = currentBalance != null && total > 0 ? currentBalance / total : null;

  async function handleSave(e) {
    e.preventDefault();
    setError(null); setSavedMessage(null); setSaving(true);
    try {
      const res = await fetch(`${apiBase}/api/milestones`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          monthlyCosts: {
            hosting: Number(costs.hosting) || 0,
            oddsApi: Number(costs.oddsApi) || 0,
            other: Number(costs.other) || 0,
          },
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setSavedMessage("Saved.");
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }

  return (
    <div className="panel">
      <h2>Monthly Cost Tracking</h2>
      <p className="setup-copy">
        Purely informational - tracks what this project actually costs you each month
        against your current balance. Does not move money or change any trading behavior.
      </p>
      <form onSubmit={handleSave}>
        <label className="field-label">Hosting ($/mo)</label>
        <input type="text" value={costs.hosting} onChange={(e) => setCosts({ ...costs, hosting: e.target.value })} placeholder="e.g. 25" />
        <label className="field-label">Odds API subscription ($/mo)</label>
        <input type="text" value={costs.oddsApi} onChange={(e) => setCosts({ ...costs, oddsApi: e.target.value })} placeholder="e.g. 99" />
        <label className="field-label">Other ($/mo)</label>
        <input type="text" value={costs.other} onChange={(e) => setCosts({ ...costs, other: e.target.value })} placeholder="e.g. 0" />
        {error && <div className="error-banner setup-error">{error}</div>}
        {savedMessage && <div className="file-chip" style={{ marginTop: 12 }}>{savedMessage}</div>}
        <button type="submit" disabled={saving}>{saving ? "Saving..." : "Save costs"}</button>
      </form>

      <div className="bot-subsection">
        <div className="cost-row"><span>Hosting</span><span>${(Number(costs.hosting) || 0).toFixed(2)}</span></div>
        <div className="cost-row"><span>Odds API</span><span>${(Number(costs.oddsApi) || 0).toFixed(2)}</span></div>
        <div className="cost-row"><span>Other</span><span>${(Number(costs.other) || 0).toFixed(2)}</span></div>
        <div className="cost-row"><span>Total / month</span><span>${total.toFixed(2)}</span></div>
      </div>

      {monthsOfCoverage != null && (
        <p className="setup-copy" style={{ marginTop: 16 }}>
          At this rate, your current balance (${currentBalance.toFixed(2)}) covers roughly{" "}
          <strong className={monthsOfCoverage < 1 ? "neg" : "pos"}>
            {monthsOfCoverage.toFixed(2)} month{monthsOfCoverage === 1 ? "" : "s"}
          </strong>{" "}
          of overhead by itself, before accounting for any trading results.
        </p>
      )}
    </div>
  );
}
