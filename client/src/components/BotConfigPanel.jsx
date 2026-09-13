import React, { useEffect, useState } from "react";

/**
 * Lets you edit the live bot config directly, which matters because the
 * config file lives on the persistent Volume - editing bot-config.json in
 * the repo does NOT change an already-deployed instance (by design, so a
 * redeploy never silently wipes your tuned settings).
 */
export default function BotConfigPanel({ apiBase }) {
  const [config, setConfig] = useState(null);
  const [sportsText, setSportsText] = useState("");
  const [scanInterval, setScanInterval] = useState("");
  const [entryWindow, setEntryWindow] = useState("");
  const [maxPositions, setMaxPositions] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(null);

  async function refresh() {
    try {
      const res = await fetch(`${apiBase}/api/bot/config`);
      const data = await res.json();
      setConfig(data);
      setSportsText((data.sportsPool || data.sports || []).join("\n"));
      setScanInterval(String(data.scanIntervalMinutes ?? ""));
      setEntryWindow(String(data.entryWindowHours ?? ""));
      setMaxPositions(String(data.maxConcurrentPositions ?? ""));
    } catch (err) { setError(err.message); }
  }

  useEffect(() => { refresh(); }, []);

  async function handleSave(e) {
    e.preventDefault();
    setError(null); setSaved(null); setSaving(true);
    try {
      const sportsPool = sportsText.split("\n").map((s) => s.trim()).filter(Boolean);
      const updates = {
        sportsPool,
        scanIntervalMinutes: Number(scanInterval),
        entryWindowHours: Number(entryWindow),
        maxConcurrentPositions: Number(maxPositions),
      };
      const res = await fetch(`${apiBase}/api/bot/config`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setSaved("Saved. Stop and restart the bot for the new scan interval to take effect.");
      refresh();
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }

  if (!config) return <div className="panel"><h2>Bot Settings</h2><p className="muted">Loading...</p></div>;

  return (
    <div className="panel">
      <h2>Bot Settings (Live)</h2>
      <p className="setup-copy">
        These edit the running config on the server's persistent volume - which is
        what the bot actually reads. Editing bot-config.json in the repo won't change
        an already-deployed instance.
      </p>
      <form onSubmit={handleSave}>
        <label className="field-label">Sports pool (one key per line)</label>
        <textarea
          value={sportsText}
          onChange={(e) => setSportsText(e.target.value)}
          rows={10}
          style={{
            width: "100%", background: "var(--bg)", border: "1px solid var(--panel-border)",
            borderRadius: 4, padding: "10px 12px", color: "var(--text)",
            fontFamily: "IBM Plex Mono, monospace", fontSize: 13,
          }}
        />
        <label className="field-label">Scan interval (minutes)</label>
        <input type="text" value={scanInterval} onChange={(e) => setScanInterval(e.target.value)} />
        <label className="field-label">Entry window (hours before start)</label>
        <input type="text" value={entryWindow} onChange={(e) => setEntryWindow(e.target.value)} />
        <label className="field-label">Max concurrent positions</label>
        <input type="text" value={maxPositions} onChange={(e) => setMaxPositions(e.target.value)} />
        {error && <div className="error-banner setup-error">{error}</div>}
        {saved && <div className="file-chip" style={{ marginTop: 12 }}>{saved}</div>}
        <button type="submit" disabled={saving}>{saving ? "Saving..." : "Save settings"}</button>
      </form>
    </div>
  );
}
