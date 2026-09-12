import React, { useState } from "react";
export default function EnvironmentToggle({ apiBase, environment, onChanged }) {
  const [pendingTarget, setPendingTarget] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  function requestSwitch(target) {
    if (target === environment) return;
    setError(null);
    setPendingTarget(target);
  }

  async function confirmSwitch() {
    setBusy(true); setError(null);
    try {
      const res = await fetch(`${apiBase}/api/bot/environment`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ environment: pendingTarget, confirmed: true }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || "Failed to switch environment.");
      onChanged(data.environment);
      setPendingTarget(null);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  return (
    <div className="env-toggle">
      <div className="env-toggle-row">
        <span className="field-label" style={{ margin: 0 }}>Environment</span>
        <div className="env-pill-group">
          <button type="button" className={`env-pill ${environment === "demo" ? "env-pill-active env-pill-demo" : ""}`} onClick={() => requestSwitch("demo")}>Demo</button>
          <button type="button" className={`env-pill ${environment === "production" ? "env-pill-active env-pill-live" : ""}`} onClick={() => requestSwitch("production")}>Live</button>
        </div>
      </div>
      {pendingTarget && (
        <div className="modal-backdrop">
          <div className="modal-panel">
            {pendingTarget === "demo" ? (
              <><h3>Switching to Demo</h3><p>You're entering <strong>demo / paper-trading</strong>. No real funds will be touched.</p></>
            ) : (
              <><h3>Switching to Live Trading</h3><p>You're about to use your <strong>real Kalshi portfolio funds</strong>. Trades placed from here are real and can result in real losses.</p></>
            )}
            {error && <div className="error-banner">{error}</div>}
            <div className="modal-actions">
              <button type="button" className="modal-cancel" onClick={() => setPendingTarget(null)}>Cancel</button>
              <button type="button" onClick={confirmSwitch} disabled={busy}>{busy ? "Switching..." : `Yes, switch to ${pendingTarget === "demo" ? "Demo" : "Live"}`}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
