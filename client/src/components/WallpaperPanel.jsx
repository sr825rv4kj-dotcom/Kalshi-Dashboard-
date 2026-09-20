import React, { useEffect, useRef, useState } from "react";
import {
  BUILTIN, applyWallpaper, defaultSettings, nextWallpaper,
  readLocal, writeLocal, looksLikeVideo,
} from "../wallpapers.js";

/**
 * A live, animating thumbnail of one wallpaper.
 *
 * A still swatch is a poor way to choose a moving wallpaper - Ribbons and Ink
 * look nearly identical frozen. Each tile runs the real effect at a small size
 * and a low frame rate, so the grid shows what you are actually picking.
 */
function SwatchPreview({ def }) {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let reduced = false;
    try { reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { /* ignore */ }

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = canvas.clientWidth || 96;
    const h = canvas.clientHeight || 128;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const draw = def.make();
    if (reduced) { draw(ctx, w, h, 0); return; }

    // Ten frames a second is plenty for a thumbnail and leaves the main
    // wallpaper the headroom it needs.
    let raf = null, timer = null;
    const t0 = performance.now();
    const tick = () => {
      draw(ctx, w, h, (performance.now() - t0) / 1000);
      timer = setTimeout(() => { raf = requestAnimationFrame(tick); }, 100);
    };
    raf = requestAnimationFrame(tick);
    return () => { if (raf) cancelAnimationFrame(raf); if (timer) clearTimeout(timer); };
  }, [def]);

  return <canvas ref={ref} aria-hidden="true" />;
}

/**
 * Wallpaper picker.
 *
 * The built-in animations are drawn by the browser and always work. The URL
 * box takes any direct link to an mp4, webm, gif or image. The upload button
 * takes a file straight off the phone, which is how anything from an app-gated
 * site like ispazio's gets in - save it to Photos first, then upload it here.
 *
 * Settings are written to the server so the look follows the account, and
 * mirrored to local storage so the wallpaper paints instantly on next load
 * instead of flashing plain black while the API call is in flight.
 */
export default function WallpaperPanel({ apiBase }) {
  const [settings, setSettings] = useState(() => readLocal() || defaultSettings());
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);
  const rotateRef = useRef(null);

  // --- load the server copy once, then keep the two in step ---------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${apiBase}/api/background`);
        const data = await res.json();
        if (cancelled || !data || data.error) return;
        const merged = { ...defaultSettings(), ...data };
        setSettings(merged);
        writeLocal(merged);
        applyWallpaper(merged.active);
      } catch {
        // offline or not logged in - the local copy is already applied
      }
    })();
    return () => { cancelled = true; };
  }, [apiBase]);

  async function persist(next) {
    setSettings(next);
    writeLocal(next);
    applyWallpaper(next.active);
    try {
      const res = await fetch(`${apiBase}/api/background`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
    } catch (err) {
      setError(`Saved on this device, but not to the server: ${err.message}`);
    }
  }

  // --- manual rotation timer ---------------------------------------------
  useEffect(() => {
    if (rotateRef.current) clearInterval(rotateRef.current);
    if (!settings.rotate) return;
    const ms = Math.max(1, Number(settings.rotateMinutes) || 15) * 60 * 1000;
    rotateRef.current = setInterval(() => {
      setSettings((cur) => {
        const next = { ...cur, active: nextWallpaper(cur) };
        writeLocal(next);
        applyWallpaper(next.active);
        return next;
      });
    }, ms);
    return () => { if (rotateRef.current) clearInterval(rotateRef.current); };
  }, [settings.rotate, settings.rotateMinutes, settings.library]);

  function choose(active) {
    setError(null);
    persist({ ...settings, active });
  }

  function shuffle() {
    setError(null);
    persist({ ...settings, active: nextWallpaper(settings) });
  }

  async function addUrl(e) {
    e.preventDefault();
    setError(null); setNote(null);
    const clean = url.trim();
    if (!clean) return;
    if (!/^https:\/\//i.test(clean)) {
      setError("Use an https:// link. A plain http link is blocked by the browser on a secure page.");
      return;
    }
    const item = {
      id: `l${Date.now()}`,
      label: label.trim() || (looksLikeVideo(clean) ? "Video wallpaper" : "Image wallpaper"),
      type: "url",
      url: clean,
    };
    await persist({ ...settings, library: [...(settings.library || []), item], active: { type: "url", url: clean } });
    setUrl(""); setLabel("");
    setNote("Added. If it does not appear, the host is blocking direct links - download the file and use Upload instead.");
  }

  async function upload(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null); setNote(null); setBusy(true);
    try {
      // Checked here as well as on the server: base64 inflates the file by a
      // third, and the server's JSON body limit is 10MB, so a larger file
      // fails in the body parser with an opaque error instead of this one.
      if (file.size > 6 * 1024 * 1024) {
        throw new Error(`That file is ${(file.size / 1024 / 1024).toFixed(1)}MB - keep it under 6MB. A looping wallpaper rarely needs more, and it keeps the dashboard quick to open on cellular.`);
      }
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error("Could not read that file."));
        reader.readAsDataURL(file);
      });
      const item = { id: `u${Date.now()}`, label: file.name.slice(0, 40), type: "upload", dataUrl };
      await persist({ ...settings, library: [...(settings.library || []), item], active: { type: "upload", dataUrl } });
      setNote("Uploaded and saved to your account.");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
      e.target.value = "";
    }
  }

  function removeItem(id) {
    const library = (settings.library || []).filter((i) => i.id !== id);
    const removed = (settings.library || []).find((i) => i.id === id);
    const isActive = removed && (
      (removed.type === "url" && settings.active?.url === removed.url) ||
      (removed.type === "upload" && settings.active?.dataUrl === removed.dataUrl)
    );
    persist({ ...settings, library, active: isActive ? { type: "builtin", key: "aurora" } : settings.active });
  }

  const activeKey = settings.active?.type === "builtin" ? settings.active.key : null;

  return (
    <div className="panel">
      <h2>Wallpaper</h2>

      <div className="wp-grid">
        {BUILTIN.map((b) => (
          <button
            key={b.key}
            type="button"
            className={`wp-swatch ${activeKey === b.key ? "wp-swatch-active" : ""}`}
            onClick={() => choose({ type: "builtin", key: b.key })}
            style={{ background: b.base }}
          >
            <SwatchPreview def={b} />
            <span className="wp-swatch-name">{b.name}</span>
          </button>
        ))}
      </div>

      <div className="wp-actions">
        <button type="button" className="wp-btn" onClick={shuffle}>Next wallpaper</button>
        <button
          type="button"
          className={`wp-btn ${settings.rotate ? "wp-btn-on" : ""}`}
          onClick={() => persist({ ...settings, rotate: !settings.rotate })}
        >
          {settings.rotate ? `Rotating every ${settings.rotateMinutes}m` : "Auto-rotate off"}
        </button>
        {settings.rotate && (
          <select
            className="wp-select"
            value={settings.rotateMinutes}
            onChange={(e) => persist({ ...settings, rotateMinutes: Number(e.target.value) })}
          >
            {[5, 15, 30, 60, 180, 720].map((m) => (
              <option key={m} value={m}>{m < 60 ? `${m} min` : `${m / 60} hr`}</option>
            ))}
          </select>
        )}
        <button type="button" className="wp-btn" onClick={() => choose({ type: "none" })}>Plain</button>
      </div>

      {(settings.library || []).length > 0 && (
        <>
          <div className="field-label" style={{ marginTop: 18 }}>Your wallpapers</div>
          <div className="wp-list">
            {settings.library.map((item) => {
              const isActive =
                (item.type === "url" && settings.active?.url === item.url) ||
                (item.type === "upload" && settings.active?.dataUrl === item.dataUrl);
              return (
                <div key={item.id} className={`wp-item ${isActive ? "wp-item-active" : ""}`}>
                  <button
                    type="button"
                    className="wp-item-main"
                    onClick={() => choose(item.type === "upload" ? { type: "upload", dataUrl: item.dataUrl } : { type: "url", url: item.url })}
                  >
                    <span className="wp-item-kind">{item.type === "upload" ? "FILE" : "LINK"}</span>
                    <span className="wp-item-label">{item.label}</span>
                  </button>
                  <button type="button" className="wp-item-x" onClick={() => removeItem(item.id)} aria-label="Remove">×</button>
                </div>
              );
            })}
          </div>
        </>
      )}

      <form onSubmit={addUrl} className="wp-form">
        <label className="field-label" htmlFor="wpUrl">Add from a link</label>
        <input
          id="wpUrl" className="wp-input" type="url" inputMode="url" placeholder="https://.../wallpaper.mp4"
          value={url} onChange={(e) => setUrl(e.target.value)}
        />
        <input
          className="wp-input" type="text" placeholder="Name (optional)"
          value={label} onChange={(e) => setLabel(e.target.value)}
        />
        <button type="submit" className="wp-btn wp-btn-primary">Add link</button>
      </form>

      <div className="field-label" style={{ marginTop: 18 }}>Upload from this phone</div>
      <input type="file" accept="image/*,video/mp4,video/webm" onChange={upload} disabled={busy} />

      <p className="setup-copy" style={{ marginTop: 14 }}>
        The eight animations above are drawn by the browser - no download, no data, and they
        keep working even if a wallpaper site goes offline. For outside wallpapers, paste a direct
        https link to an mp4, webm, gif or image.
      </p>
      <p className="setup-copy">
        <strong>wallpapers.ispazio.net</strong> serves its live wallpapers only through the Wallpapers
        Central app, behind its coin system - there are no direct links on that site to paste. Save one
        to your Photos from the app, then use Upload above. Free sources that do allow direct linking
        include Pexels Videos, Coverr and Pixabay.
      </p>

      {note && <div className="wp-note">{note}</div>}
      {error && <div className="error-banner setup-error">{error}</div>}
    </div>
  );
}
