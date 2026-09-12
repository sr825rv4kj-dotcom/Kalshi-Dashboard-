import React, { useEffect, useState } from "react";
import EnvironmentToggle from "./EnvironmentToggle.jsx";

export default function BotControlPanel({ apiBase }) {
  const [status, setStatus] = useState(null);
  const [log, setLog] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [confirmingStop, setConfirmingStop] = useState(false);

  async function refresh() {
    try {
      const [statusRes, logRes] = await Promise.all([
        fetch(`${apiBase}/api/bot/status`).then((r) => r.json()),
        fetch(`${apiBase}/api/bot/log?limit=20`).then((r) => r.json()),
      ]);
      setStatus(statusRes);
      setLog(logRes.log ?? []);
    } catch (err) { setError(err.message); }
  }

  useEffect(() => { refresh(); const i = setInterval(refresh, 15000); return () => clearInterval(i); }, []);

  async function startBot() {
    setBusy(true); setError(null);
    try {
      const res = await fetch(`${apiBase}/api/bot/start`, { method: "POST" });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      await refresh();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  async function confirmStop() {
    setBusy(true); setError(null);
    try {
      const res = await fetch(`${apiBase}/api/bot/stop`, { method: "POST" });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      await refresh();
    } catch (err) { setError(err.message); } finally { setBusy(false); setConfirmingStop(false); }
  }

  if (!status) return <div className="panel"><h2>Bot Control</h2><p className="muted">Loading status...</p></div>;

  return (
    <div className="panel bot-panel">
      <div className="bot-panel-header">
        <h2>Bot Control</h2>
        <span className={`status-dot ${status.running ? "status-on" : "status-off"}`}>{status.running ? "Running" : "Stopped"}</span>
      </div>
      <EnvironmentToggle apiBase={apiBase} environment={status.environment} onChanged={() => refresh()} />
      <div className="bot-panel-header" style={{ marginTop: 16, marginBottom: 0 }}>
        <span className="field-label" style={{ margin: 0 }}>Balance: {status.currentBalance != null ? `$${status.currentBalance.toFixed(2)}` : "—"}</span>
        {status.survivalMode && (
          <span className={`status-dot ${status.survivalMode.active ? "status-off" : "status-on"}`}>
            {status.survivalMode.active ? `Survival Mode ($${status.survivalMode.flatBetDollars} flat bets)` : "Normal Sizing"}
          </span>
        )}
      </div>
      {status.haltedForDay && <div className="error-banner" style={{ marginTop: 16 }}>Trading halted for today: {status.haltReason}</div>}
      {error && <div className="error-banner" style={{ marginTop: 16 }}>{error}</div>}
      {status.running ? (
        <button type="button" className="danger-button" onClick={() => setConfirmingStop(true)} disabled={busy} style={{ marginTop: 20 }}>Stop Bot</button>
      ) : (
        <button type="button" onClick={startBot} disabled={busy} style={{ marginTop: 20 }}>{busy ? "Working..." : "Start Bot"}</button>
      )}
      {confirmingStop && (
        <div className="modal-backdrop">
          <div className="modal-panel">
            <h3>Stop the bot?</h3>
            <p>This stops all scanning and trading immediately. Open positions stay open on Kalshi.</p>
            <div className="modal-actions">
              <button type="button" className="modal-cancel" onClick={() => setConfirmingStop(false)}>Cancel</button>
              <button type="button" onClick={confirmStop} disabled={busy}>{busy ? "Stopping..." : "Yes, stop it"}</button>
            </div>
          </div>
        </div>
      )}
      <div className="bot-subsection">
        <h3>Open Positions ({status.openPositions?.length ?? 0})</h3>
        {!status.openPositions?.length ? <div className="empty-state">No open positions from the bot.</div> : (
          <table>
            <thead><tr><th>Ticker</th><th>Side</th><th>Entry</th><th>Contracts</th></tr></thead>
            <tbody>{status.openPositions.map((p, i) => (
              <tr key={i}><td>{p.ticker}</td><td className={p.side === "yes" ? "pos" : "neg"}>{p.side.toUpperCase()}</td><td>{p.entryPriceCents}c</td><td>{p.contracts}</td></tr>
            ))}</tbody>
          </table>
        )}
      </div>
      <div className="bot-subsection">
        <h3>Recent Activity</h3>
        {!log.length ? <div className="empty-state">No activity yet.</div> : (
          <div className="log-list">{log.map((entry, i) => (
            <div key={i} className={`log-line log-${entry.level}`}><span className="log-time">{new Date(entry.time).toLocaleTimeString()}</span>{entry.message}</div>
          ))}</div>
        )}
      </div>
    </div>
  );
}
