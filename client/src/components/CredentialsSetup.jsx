import React, { useState } from "react";

/**
 * Accepts the private key by paste as well as by file. On a phone the file
 * route is fragile - iOS renames downloads, text editors strip line breaks,
 * and Kalshi only lets you download the key once - so pasting is usually the
 * more reliable path. The key is validated here before it is sent, so a
 * malformed paste fails with a clear message instead of a signing error later.
 */
export default function CredentialsSetup({ apiBase, onSaved }) {
  const [keyId, setKeyId] = useState("");
  const [pemContent, setPemContent] = useState("");
  const [pemFileName, setPemFileName] = useState("");
  const [environment, setEnvironment] = useState("production");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  function handleFileSelect(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setPemFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => setPemContent(String(reader.result));
    reader.onerror = () => setError("Could not read that file.");
    reader.readAsText(file);
  }

  /** Normalizes line endings and checks this is actually a private key. */
  function validateKey(raw) {
    const key = raw.replace(/\r\n/g, "\n").trim();
    if (!key) return { error: "Paste your private key, or choose the file Kalshi gave you." };
    if (/BEGIN[\s\S]*PUBLIC KEY/.test(key)) {
      return { error: "That's the public key. Kalshi also gives you a private key - it's the one you need here." };
    }
    if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(key)) {
      return { error: "That doesn't look like a private key. It should start with -----BEGIN RSA PRIVATE KEY-----" };
    }
    if (!/-----END [A-Z ]*PRIVATE KEY-----/.test(key)) {
      return { error: "The key looks cut off - the -----END ... PRIVATE KEY----- line is missing." };
    }
    if (key.split("\n").length < 4) {
      return { error: "The key's line breaks were lost. Re-copy it so each line stays on its own row." };
    }
    return { key };
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);

    if (!keyId.trim()) { setError("Enter your Kalshi API Key ID."); return; }
    const checked = validateKey(pemContent);
    if (checked.error) { setError(checked.error); return; }

    setSaving(true);
    try {
      const baseUrl = environment === "production"
        ? "https://api.elections.kalshi.com/trade-api/v2"
        : "https://demo-api.kalshi.co/trade-api/v2";
      const res = await fetch(`${apiBase}/api/credentials`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keyId: keyId.trim(), privateKeyPem: checked.key, baseUrl }),
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
          Stored only on your own backend so you never re-enter them. Never sent anywhere else.
        </p>
        <form onSubmit={handleSubmit}>
          <label className="field-label" htmlFor="keyId">Kalshi API Key ID</label>
          <input
            id="keyId" type="text" value={keyId}
            onChange={(e) => setKeyId(e.target.value)}
            placeholder="e.g. 4f2a1c9e-..." autoComplete="off"
          />

          <label className="field-label" htmlFor="pemPaste">Private key - paste it here</label>
          <textarea
            id="pemPaste" rows={8} value={pemContent}
            onChange={(e) => { setPemContent(e.target.value); setPemFileName(""); }}
            placeholder={"-----BEGIN RSA PRIVATE KEY-----\nMIIEogIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----"}
            autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck="false"
            style={{ fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12 }}
          />

          <label className="field-label" htmlFor="pemFile">Or choose the file instead</label>
          <input id="pemFile" type="file" accept=".pem,.txt,.key" onChange={handleFileSelect} />
          {pemFileName && <div className="file-chip">Loaded: {pemFileName}</div>}

          <label className="field-label" htmlFor="environment">Environment</label>
          <select id="environment" value={environment} onChange={(e) => setEnvironment(e.target.value)}>
            <option value="production">Production (real account)</option>
            <option value="demo">Demo / paper trading</option>
          </select>

          {error && <div className="error-banner setup-error">{error}</div>}
          <button type="submit" disabled={saving}>{saving ? "Saving..." : "Save and connect"}</button>
        </form>

        {/* Without these this screen is a dead end: you cannot reach the
            dashboard without a key, and cannot get back to the login page. */}
        <button type="button" className="modal-cancel" style={{ marginTop: 12 }} onClick={onSaved}>
          Skip for now - go to the dashboard
        </button>
        <button
          type="button" className="modal-cancel" style={{ marginTop: 8 }}
          onClick={() => {
            try { localStorage.removeItem("kalshi_dashboard_token"); } catch { /* ignore */ }
            window.location.reload();
          }}
        >
          Log out
        </button>
      </div>
    </div>
  );
}
