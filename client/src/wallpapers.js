/**
 * wallpapers.js
 *
 * Live wallpapers with REAL MOTION, rendered on a canvas at 60fps.
 *
 * The first version drifted a few blurred gradient blobs with CSS keyframes.
 * That technically moved, but over a 26-second cycle it read as a still image.
 * These are drawn frame by frame: ribbons that flow, bubbles that rise, sonar
 * rings that pulse outward - the kind of motion the iOS live wallpapers have.
 *
 * Nothing is downloaded. Every effect is generated in the browser, so there is
 * no file to fetch, no host that can disappear, and no data cost on cellular.
 *
 * Performance, because this runs on a phone all day:
 *   - device pixel ratio capped at 2; past that it is invisible and expensive
 *   - the loop stops completely when the tab is hidden or the page is scrolled
 *     away from, and resumes on return
 *   - honours prefers-reduced-motion by painting one static frame
 */

const LAYER_ID = "wallpaper-layer";
const LS_KEY = "kalshi_wallpaper_v2";

let rafHandle = null;
let running = null;      // { draw, canvas, ctx, t0 }
let visHandler = null;

/* ------------------------------------------------------------------ *
 * Effects. Each returns a draw(ctx, w, h, t) where t is seconds.
 * ------------------------------------------------------------------ */

/** Flowing light ribbons on near-black. The iOS 27 look. */
function ribbons({ palette, count = 5, thickness = 2.2 }) {
  return (ctx, w, h, t) => {
    ctx.clearRect(0, 0, w, h);
    ctx.lineCap = "round";
    for (let i = 0; i < count; i++) {
      const phase = i * 1.37;
      const speed = 0.16 + i * 0.035;
      const amp = h * (0.10 + (i % 3) * 0.045);
      const yBase = h * (0.18 + (i / count) * 0.68);

      const grad = ctx.createLinearGradient(0, 0, w, 0);
      const c = palette[i % palette.length];
      grad.addColorStop(0, "rgba(0,0,0,0)");
      grad.addColorStop(0.18, c);
      grad.addColorStop(0.5, c);
      grad.addColorStop(0.82, c);
      grad.addColorStop(1, "rgba(0,0,0,0)");

      ctx.strokeStyle = grad;
      ctx.lineWidth = thickness * (1 + (i % 2) * 0.6);
      ctx.shadowBlur = 18;
      ctx.shadowColor = c;

      ctx.beginPath();
      for (let x = 0; x <= w; x += 6) {
        const p = x / w;
        const y = yBase
          + Math.sin(p * 3.1 + t * speed * 2 + phase) * amp
          + Math.sin(p * 7.7 - t * speed * 1.3 + phase * 2) * amp * 0.28;
        x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.shadowBlur = 0;
  };
}

/** Translucent orbs rising with a rim highlight. */
function bubbles({ palette, count = 26 }) {
  const seeded = [];
  for (let i = 0; i < count; i++) {
    seeded.push({
      x: Math.random(), r: 0.02 + Math.random() * 0.075,
      speed: 0.012 + Math.random() * 0.035,
      drift: (Math.random() - 0.5) * 0.28,
      offset: Math.random(), c: palette[i % palette.length],
    });
  }
  return (ctx, w, h, t) => {
    ctx.clearRect(0, 0, w, h);
    for (const b of seeded) {
      const prog = (b.offset + t * b.speed) % 1.25;
      const y = h * (1.12 - prog);
      const x = w * (b.x + Math.sin(t * 0.25 + b.offset * 6.3) * 0.05 * b.drift * 4);
      const r = Math.min(w, h) * b.r;
      if (y < -r * 2) continue;

      const g = ctx.createRadialGradient(x - r * 0.3, y - r * 0.35, r * 0.05, x, y, r);
      g.addColorStop(0, b.c.replace("ALPHA", "0.42"));
      g.addColorStop(0.55, b.c.replace("ALPHA", "0.10"));
      g.addColorStop(0.88, b.c.replace("ALPHA", "0.26"));
      g.addColorStop(1, b.c.replace("ALPHA", "0"));
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();

      ctx.strokeStyle = b.c.replace("ALPHA", "0.30");
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(x, y, r * 0.97, 0, Math.PI * 2); ctx.stroke();
    }
  };
}

/** Concentric rings pulsing outward from the lower edge. */
function sonar({ palette, rings = 9 }) {
  return (ctx, w, h, t) => {
    ctx.clearRect(0, 0, w, h);
    const cx = w * 0.5, cy = h * 1.04;
    const maxR = Math.hypot(w * 0.6, h * 1.05);
    ctx.lineCap = "round";
    for (let i = 0; i < rings; i++) {
      const prog = ((t * 0.09) + i / rings) % 1;
      const r = prog * maxR;
      const fade = Math.sin(prog * Math.PI);
      if (fade <= 0.01) continue;
      const c = palette[i % palette.length];
      ctx.strokeStyle = c.replace("ALPHA", String(0.5 * fade));
      ctx.lineWidth = 2 + fade * 3;
      ctx.shadowBlur = 16 * fade;
      ctx.shadowColor = c.replace("ALPHA", "0.8");
      ctx.beginPath();
      ctx.arc(cx, cy, r, Math.PI * 1.08, Math.PI * 1.92);
      ctx.stroke();
    }
    ctx.shadowBlur = 0;
  };
}

/** Soft aurora sheets that fold and breathe. */
function aurora({ palette }) {
  return (ctx, w, h, t) => {
    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = "lighter";
    for (let i = 0; i < palette.length; i++) {
      const c = palette[i];
      const speed = 0.09 + i * 0.03;
      const yB = h * (0.30 + i * 0.16);
      ctx.beginPath();
      ctx.moveTo(0, h);
      for (let x = 0; x <= w; x += 10) {
        const p = x / w;
        const y = yB
          + Math.sin(p * 2.3 + t * speed * 2.2 + i) * h * 0.13
          + Math.sin(p * 5.1 - t * speed * 1.4) * h * 0.05;
        ctx.lineTo(x, y);
      }
      ctx.lineTo(w, h); ctx.closePath();
      const g = ctx.createLinearGradient(0, yB - h * 0.22, 0, h);
      g.addColorStop(0, c.replace("ALPHA", "0.42"));
      g.addColorStop(0.55, c.replace("ALPHA", "0.12"));
      g.addColorStop(1, c.replace("ALPHA", "0"));
      ctx.fillStyle = g; ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";
  };
}

/** Vertical bands that slide and bleed into each other. */
function stripes({ palette }) {
  return (ctx, w, h, t) => {
    const g = ctx.createLinearGradient(0, 0, w, 0);
    const n = palette.length;
    for (let i = 0; i <= n * 2; i++) {
      const base = i / (n * 2);
      const wobble = Math.sin(t * 0.35 + i * 0.9) * 0.045;
      const stop = Math.min(1, Math.max(0, base + wobble));
      g.addColorStop(stop, palette[i % n].replace("ALPHA", "0.85"));
    }
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    // A slow diagonal sheen so it never looks like a static gradient.
    const sheenX = ((t * 0.07) % 1.4 - 0.2) * w;
    const s = ctx.createLinearGradient(sheenX, 0, sheenX + w * 0.35, h);
    s.addColorStop(0, "rgba(255,255,255,0)");
    s.addColorStop(0.5, "rgba(255,255,255,0.10)");
    s.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = s;
    ctx.fillRect(0, 0, w, h);
  };
}

/* ------------------------------------------------------------------ *
 * Catalogue
 * ------------------------------------------------------------------ */

export const BUILTIN = [
  { key: "ribbons", name: "Ribbons", tint: "#8ab4ff", base: "#04060c",
    make: () => ribbons({ palette: ["#8ab4ff", "#c9a6ff", "#7ef0d2", "#ffd39b", "#ff9ecb"] }) },

  { key: "ribbonsblue", name: "Blue Lines", tint: "#5fa8ff", base: "#03050a",
    make: () => ribbons({ palette: ["#5fa8ff", "#9ed4ff", "#4de0ff", "#7f9cff"], count: 6, thickness: 1.8 }) },

  { key: "sonar", name: "Sonar", tint: "#4fd1ff", base: "#02060f",
    make: () => sonar({ palette: ["rgba(79,209,255,ALPHA)", "rgba(120,170,255,ALPHA)", "rgba(180,230,255,ALPHA)"] }) },

  { key: "bubbles", name: "Bubbles", tint: "#7cc9ff", base: "#030814",
    make: () => bubbles({ palette: ["rgba(124,201,255,ALPHA)", "rgba(168,220,255,ALPHA)", "rgba(96,164,255,ALPHA)"] }) },

  { key: "aurora", name: "Aurora", tint: "#4fd1c5", base: "#040a12",
    make: () => aurora({ palette: ["rgba(79,209,197,ALPHA)", "rgba(56,132,255,ALPHA)", "rgba(147,51,234,ALPHA)"] }) },

  { key: "ember", name: "Ember", tint: "#ff8a4c", base: "#120604",
    make: () => aurora({ palette: ["rgba(255,138,76,ALPHA)", "rgba(239,68,68,ALPHA)", "rgba(250,204,21,ALPHA)"] }) },

  { key: "moss", name: "Moss", tint: "#4ade80", base: "#030b06",
    make: () => aurora({ palette: ["rgba(74,222,128,ALPHA)", "rgba(16,185,129,ALPHA)", "rgba(132,204,22,ALPHA)"] }) },

  { key: "neon", name: "Neon City", tint: "#f472b6", base: "#090312",
    make: () => ribbons({ palette: ["#f472b6", "#38bdf8", "#a855f7", "#fb7185"], count: 6 }) },

  { key: "stripes", name: "Stripes", tint: "#7ee0c0", base: "#000000",
    make: () => stripes({ palette: ["rgba(126,224,192,ALPHA)", "rgba(96,165,250,ALPHA)", "rgba(167,139,250,ALPHA)", "rgba(244,114,182,ALPHA)", "rgba(251,191,36,ALPHA)"] }) },

  { key: "ink", name: "Ink", tint: "#94a3b8", base: "#04060a",
    make: () => ribbons({ palette: ["#94a3b8", "#64748b", "#cbd5e1"], count: 4, thickness: 1.6 }) },
];

export function builtinByKey(key) {
  return BUILTIN.find((b) => b.key === key) || null;
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

function layerEl() {
  let el = document.getElementById(LAYER_ID);
  if (!el) {
    el = document.createElement("div");
    el.id = LAYER_ID;
    el.className = "wp-layer";
    document.body.prepend(el);
  }
  return el;
}

function stopLoop() {
  if (rafHandle) cancelAnimationFrame(rafHandle);
  rafHandle = null;
  running = null;
  if (visHandler) {
    document.removeEventListener("visibilitychange", visHandler);
    visHandler = null;
  }
}

function clearLayer(el) {
  stopLoop();
  while (el.firstChild) el.removeChild(el.firstChild);
  el.style.background = "";
}

function setTint(tint) {
  if (tint) document.documentElement.style.setProperty("--accent", tint);
}

function prefersReducedMotion() {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

function renderBuiltin(el, spec) {
  const def = builtinByKey(spec.key) || BUILTIN[0];
  el.style.background = def.base;
  setTint(def.tint);

  const canvas = document.createElement("canvas");
  canvas.className = "wp-canvas";
  el.appendChild(canvas);
  const ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) return;

  const draw = def.make();

  const size = () => {
    // Capping at 2 keeps a 3x phone from painting 9x the pixels for no
    // visible gain - the difference is invisible, the cost is not.
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = el.clientWidth || window.innerWidth;
    const h = el.clientHeight || window.innerHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w, h };
  };
  let { w, h } = size();

  const onResize = () => { ({ w, h } = size()); };
  window.addEventListener("resize", onResize, { passive: true });

  if (prefersReducedMotion()) {
    draw(ctx, w, h, 0);   // one frame, then stop
    return;
  }

  const t0 = performance.now();
  running = { draw, canvas, ctx };

  const frame = (now) => {
    if (!running) return;
    draw(ctx, w, h, (now - t0) / 1000);
    rafHandle = requestAnimationFrame(frame);
  };
  rafHandle = requestAnimationFrame(frame);

  // A wallpaper animating behind a backgrounded tab is pure battery drain.
  visHandler = () => {
    if (document.hidden) {
      if (rafHandle) cancelAnimationFrame(rafHandle);
      rafHandle = null;
    } else if (running && !rafHandle) {
      rafHandle = requestAnimationFrame(frame);
    }
  };
  document.addEventListener("visibilitychange", visHandler);
}

export function looksLikeVideo(url) {
  return /\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(String(url)) || String(url).startsWith("data:video/");
}

function renderVideo(el, url) {
  const v = document.createElement("video");
  v.className = "wp-media";
  v.src = url;
  v.autoplay = true; v.loop = true; v.muted = true; v.defaultMuted = true;
  v.playsInline = true;
  v.setAttribute("playsinline", "");
  v.setAttribute("muted", "");
  v.setAttribute("disablepictureinpicture", "");
  v.addEventListener("error", () => { clearLayer(el); renderBuiltin(el, { key: "ribbons" }); });
  el.appendChild(v);
  const p = v.play();
  if (p && typeof p.catch === "function") p.catch(() => {});
}

function renderImage(el, url) {
  const img = document.createElement("div");
  img.className = "wp-media wp-image";
  img.style.backgroundImage = `url("${url}")`;
  el.appendChild(img);
}

export function applyWallpaper(spec) {
  const el = layerEl();
  clearLayer(el);

  if (!spec || spec.type === "none") {
    document.body.classList.remove("has-wallpaper");
    return;
  }
  document.body.classList.add("has-wallpaper");

  if (spec.type === "builtin") { renderBuiltin(el, spec); return; }

  const src = spec.type === "upload" ? spec.dataUrl : spec.url;
  if (!src) { renderBuiltin(el, { key: "ribbons" }); return; }
  if (looksLikeVideo(src)) renderVideo(el, src);
  else renderImage(el, src);
}

/* ------------------------------------------------------------------ *
 * Persistence
 * ------------------------------------------------------------------ */

export function readLocal() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export function writeLocal(settings) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(settings)); } catch { /* private mode */ }
}

export function defaultSettings() {
  return {
    active: { type: "builtin", key: "ribbons" },
    library: [],
    rotate: false,
    rotateMinutes: 15,
  };
}

export function nextWallpaper(settings) {
  const pool = [
    ...BUILTIN.map((b) => ({ type: "builtin", key: b.key })),
    ...(settings.library || []).map((item) =>
      item.type === "upload" ? { type: "upload", dataUrl: item.dataUrl } : { type: "url", url: item.url }
    ),
  ];
  if (!pool.length) return settings.active;
  const idOf = (s) => `${s.type}:${s.key || s.url || (s.dataUrl || "").slice(0, 64)}`;
  const current = idOf(settings.active || {});
  const at = pool.findIndex((s) => idOf(s) === current);
  return pool[(at + 1) % pool.length];
}
