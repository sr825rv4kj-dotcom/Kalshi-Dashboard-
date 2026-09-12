import React, { useState } from "react";
export default function CredentialsSetup({ apiBase, onSaved }) {
  const [keyId, setKeyId] = useState("");
  const [pemFileName, setPemFileName] = useState("");
  const [pemContent, setPemContent] = useState("");
  const [environment, setEnvironment] = useState("production");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  function handleFileSelect(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setPemFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => setPemContent(reader.result);
    reader.onerror = () => setError("Could not read that file.");
    reader.readAsText(file);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    if (!keyId.trim() || !pemContent.trim()) { setError("Both the Key ID and a private key file are required."); return; }
    setSaving(true);
    try {
      const baseUrl = environment === "production" ? "https://api.elections.kalshi.com/trade-api/v2" : "https://demo-api.kalshi.co/trade-api/v2";
      const res = await fetch(`${apiBase}/api/credentials`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keyId: keyId.trim(), privateKeyPem: pemContent, baseUrl }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || "Failed to save credentials.");
      onSaved();
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }

  return (
    <div className="setup-screen">
      <div className="panel setup-panel">
        <h2>Connect your Kalshi account</h2>
        <p className="setup-copy">
          Sent only to your own backend at <code>{apiBase}</code>, which stores them
          permanently so you never re-enter them. Never sent anywhere else.
        </p>
        <form onSubmit={handleSubmit}>
          <label className="field-label" htmlFor="keyId">Kalshi API Key ID</label>
          <input id="keyId" type="text" value={keyId} onChange={(e) => setKeyId(e.target.value)} placeholder="e.g. 4f2a1c9e-..." autoComplete="off" />
          <label className="field-label" htmlFor="pemFile">Private key file (.pem)</label>
          <input id="pemFile" type="file" accept=".pem,.txt" onChange={handleFileSelect} />
          {pemFileName && <div className="file-chip">Loaded: {pemFileName}</div>}
          <label className="field-label" htmlFor="environment">Environment</label>
          <select id="environment" value={environment} onChange={(e) => setEnvironment(e.target.value)}>
            <option value="production">Production (real account)</option>
            <option value="demo">Demo / paper trading</option>
          </select>
          {error && <div className="error-banner setup-error">{error}</div>}
          <button type="submit" disabled={saving}>{saving ? "Saving..." : "Save and connect"}</button>
        </form>
      </div>
    </div>
  );
}
