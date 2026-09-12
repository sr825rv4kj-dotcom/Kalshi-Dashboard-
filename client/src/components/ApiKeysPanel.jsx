import React, { useEffect, useState } from "react";
export default function ApiKeysPanel({ apiBase }) {
  const [status, setStatus] = useState(null);
  const [oddsPapiKey, setOddsPapiKey] = useState("");
  const [theOddsApiKey, setTheOddsApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [savedMessage, setSavedMessage] = useState(null);

  async function refresh() {
    try {
      const res = await fetch(`${apiBase}/api/settings/odds-keys/status`);
      setStatus(await res.json());
    } catch (err) { setError(err.message); }
  }
  useEffect(() => { refresh(); }, []);

  async function handleSave(e) {
    e.preventDefault();
    setError(null); setSavedMessage(null);
    if (!oddsPapiKey && !theOddsApiKey) { setError("Enter at least one key to save."); return; }
    setSaving(true);
    try {
      const res = await fetch(`${apiBase}/api/settings/odds-keys`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ oddsPapiKey: oddsPapiKey || undefined, theOddsApiKey: theOddsApiKey || undefined }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setOddsPapiKey(""); setTheOddsApiKey("");
      setSavedMessage("Saved permanently - you won't need to enter this again.");
      refresh();
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }

  return (
    <div className="panel">
      <h2>Data Sources</h2>
      <p className="setup-copy">Saved permanently in your backend's persistent storage - survives restarts and redeploys.</p>
      <form onSubmit={handleSave}>
        <label className="field-label">The-Odds-API key (primary) {status?.theOddsApiConfigured && <span className="pos">(currently saved)</span>}</label>
        <input type="password" value={theOddsApiKey} onChange={(e) => setTheOddsApiKey(e.target.value)} placeholder={status?.theOddsApiConfigured ? "Enter a new key to replace" : "Paste your The-Odds-API key"} />
        <label className="field-label">OddsPapi key (fallback) {status?.oddsPapiConfigured && <span className="pos">(currently saved)</span>}</label>
        <input type="password" value={oddsPapiKey} onChange={(e) => setOddsPapiKey(e.target.value)} placeholder={status?.oddsPapiConfigured ? "Enter a new key to replace" : "Paste your OddsPapi key"} />
        {error && <div className="error-banner setup-error">{error}</div>}
        {savedMessage && <div className="file-chip" style={{ marginTop: 12 }}>{savedMessage}</div>}
        <button type="submit" disabled={saving}>{saving ? "Saving..." : "Save keys"}</button>
      </form>
    </div>
  );
}
