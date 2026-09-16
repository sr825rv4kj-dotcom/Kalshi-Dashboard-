import { getTodayTheme, THEMES } from '../themes.js';
import React, { useEffect, useState } from "react";
const [theme, setTheme] = useState(getTodayTheme());
const [animationPhase, setAnimationPhase] = useState(0);

useEffect(() => {
  const interval = setInterval(() => {
    setAnimationPhase((p) => (p + 1) % 360);
  }, 50);
  return () => clearInterval(interval);
}, []);
export default function BackgroundSettings({ apiBase }) {
  const [hasBackground, setHasBackground] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function refresh() {
    try {
      const res = await fetch(`${apiBase}/api/background`);
      const data = await res.json();
      setHasBackground(Boolean(data.dataUrl));
      if (data.dataUrl) applyBackground(data.dataUrl);
    } catch {
      // non-fatal
    }
  }

  useEffect(() => { refresh(); }, []);

  function applyBackground(dataUrl) {
    document.body.style.backgroundImage = `url(${dataUrl})`;
    document.body.style.backgroundSize = "cover";
    document.body.style.backgroundPosition = "center";
    document.body.style.backgroundAttachment = "fixed";
  }

  function clearBackgroundStyle() {
    document.body.style.backgroundImage = "";
  }

  async function handleFileChange(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null); setBusy(true);
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error("Could not read that file."));
        reader.readAsDataURL(file);
      });
      const res = await fetch(`${apiBase}/api/background`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dataUrl }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      applyBackground(dataUrl);
      setHasBackground(true);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  async function handleClear() {
    setBusy(true); setError(null);
    try {
      await fetch(`${apiBase}/api/background`, { method: "DELETE" });
      clearBackgroundStyle();
      setHasBackground(false);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  return (
    <div className="panel">
      <h2>Custom Background</h2>
      <p className="setup-copy">
        Upload any image to use as the dashboard background - saved permanently, applies on every visit.
      </p>
      <label className="field-label" htmlFor="bgFile">Background image</label>
      <input id="bgFile" type="file" accept="image/*" onChange={handleFileChange} disabled={busy} />
      {hasBackground && <div className="file-chip">Custom background active</div>}
      {error && <div className="error-banner setup-error">{error}</div>}
      {hasBackground && (
        <button type="button" className="modal-cancel" onClick={handleClear} disabled={busy} style={{ marginTop: 16 }}>
          {busy ? "Working..." : "Remove background"}
        </button>
      )}
    </div>
  );
}
