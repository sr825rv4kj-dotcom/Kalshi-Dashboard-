import React, { useEffect, useState } from "react";

export default function MilestonesPanel({ apiBase }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  async function refresh() {
    try {
      const res = await fetch(`${apiBase}/api/milestones`);
      const d = await res.json();
      if (d.error) throw new Error(d.error);
      setData(d);
    } catch (err) { setError(err.message); }
  }
  useEffect(() => { refresh(); const i = setInterval(refresh, 30000); return () => clearInterval(i); }, []);

  if (error) return <div className="panel"><h2>Milestones</h2><div className="error-banner">{error}</div></div>;
  if (!data) return null;

  const { milestones = [], currentBalance } = data;
  const nextMilestone = milestones.find((m) => currentBalance == null || m > currentBalance);
  const prevMilestone = [...milestones].reverse().find((m) => currentBalance != null && m <= currentBalance) || 0;
  const rangeSize = nextMilestone ? nextMilestone - prevMilestone : 1;
  const progressWithinRange = currentBalance != null && nextMilestone
    ? Math.min(1, Math.max(0, (currentBalance - prevMilestone) / rangeSize))
    : 0;

  return (
    <div className="panel">
      <h2>Milestones</h2>
      <p className="setup-copy">
        Informational only - this does not change position sizing or risk rules.
        Sizing is still governed entirely by the risk manager and survival-mode settings.
      </p>
      <div className="milestone-track">
        <div className="milestone-bar-bg">
          <div className="milestone-bar-fill" style={{ width: `${progressWithinRange * 100}%` }} />
        </div>
        <div className="milestone-labels">
          <span className={currentBalance >= prevMilestone ? "milestone-hit" : ""}>
            ${prevMilestone.toLocaleString()}
          </span>
          <span>
            {currentBalance != null ? `Now: $${currentBalance.toFixed(2)}` : "—"}
          </span>
          <span>
            {nextMilestone ? `Next: $${nextMilestone.toLocaleString()}` : "All set milestones reached"}
          </span>
        </div>
      </div>

      <div className="bot-subsection">
        <h3>All Milestones</h3>
        <table>
          <thead><tr><th>Target</th><th>Status</th></tr></thead>
          <tbody>
            {milestones.map((m) => (
              <tr key={m}>
                <td>${m.toLocaleString()}</td>
                <td className={currentBalance != null && currentBalance >= m ? "pos" : "muted"}>
                  {currentBalance != null && currentBalance >= m ? "Reached" : "Not yet"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
