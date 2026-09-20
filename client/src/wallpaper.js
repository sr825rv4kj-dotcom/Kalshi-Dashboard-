/**
 * wallpapers.js
 *
 * The live-wallpaper engine.
 *
 * A note on wallpapers.ispazio.net, which is what prompted this: that site
 * serves its live wallpapers through the "Wallpapers Central" app behind a
 * coin system, and exposes no direct file URLs. There is nothing there to link
 * to, so a build that only accepted a URL from that site would ship broken.
 *
 * So this engine takes three kinds of wallpaper, and the first one always
 * works with no network at all:
 *
 *   1. BUILT-IN ANIMATED - rendered live in the browser from layered gradients
 *      on the GPU. No files, no downloads, no third-party host that can go
 *      away, no data cost on cellular. These genuinely move.
 *   2. ANY DIRECT MEDIA URL - mp4, webm, gif, jpg, png. Free sources that
 *      allow direct linking (Pexels, Coverr, Pixabay) work by pasting a link.
 *   3. UPLOAD FROM THE PHONE - the realistic path for anything saved out of an
 *      app like ispazio's: save it to Photos, then upload it here. Video and
 *      images both work, and it is stored on the server so it follows the
 *      account to any device.
 *
 * Selection is manual, as asked. Rotation is available but off by default.
 */

const LAYER_ID = "wallpaper-layer";
const LS_KEY = "kalshi_wallpaper_v1";

/**
 * Built-in animated wallpapers. Each is a set of coloured light sources that
 * drift across each other - the same idea as an aurora live wallpaper, drawn
 * by the compositor instead of decoded from video.
 *
 * `tint` drives the UI accent so the dashboard recolours with the wallpaper.
 */
export const BUILTIN = [
  {
    key: "aurora",
    name: "Aurora",
    tint: "#4fd1c5",
    base: "#050b14",
    blobs: [
      ["rgba(79,209,197,0.55)", "18%", "22%", "46%"],
      ["rgba(56,132,255,0.50)", "78%", "30%", "44%"],
      ["rgba(147,51,234,0.42)", "48%", "78%", "52%"],
    ],
  },
  {
    key: "ember",
    name: "Ember",
    tint: "#ff8a4c",
    base: "#140704",
    blobs: [
      ["rgba(255,138,76,0.55)", "22%", "78%", "50%"],
      ["rgba(239,68,68,0.45)", "76%", "62%", "44%"],
      ["rgba(250,204,21,0.30)", "52%", "18%", "42%"],
    ],
  },
  {
    key: "deepsea",
    name: "Deep Sea",
    tint: "#38bdf8",
    base: "#020a16",
    blobs: [
      ["rgba(56,189,248,0.48)", "26%", "30%", "52%"],
      ["rgba(14,116,144,0.55)", "74%", "70%", "48%"],
      ["rgba(99,102,241,0.34)", "50%", "50%", "62%"],
    ],
  },
  {
    key: "neon",
    name: "Neon City",
    tint: "#f472b6",
    base: "#0a0412",
    blobs: [
      ["rgba(244,114,182,0.52)", "20%", "26%", "46%"],
      ["rgba(56,189,248,0.46)", "80%", "36%", "44%"],
      ["rgba(168,85,247,0.44)", "50%", "84%", "50%"],
    ],
  },
  {
    key: "moss",
    name: "Moss",
    tint: "#4ade80",
    base: "#040d07",
    blobs: [
      ["rgba(74,222,128,0.46)", "24%", "70%", "50%"],
      ["rgba(16,185,129,0.48)", "78%", "28%", "46%"],
      ["rgba(132,204,22,0.30)", "52%", "48%", "56%"],
    ],
  },
  {
    key: "dusk",
    name: "Dusk",
    tint: "#a78bfa",
    base: "#0b0716",
    blobs: [
      ["rgba(167,139,250,0.50)", "30%", "24%", "50%"],
      ["rgba(236,72,153,0.38)", "74%", "74%", "46%"],
      ["rgba(59,130,246,0.40)", "18%", "80%", "44%"],
    ],
  },
  {
    key: "gold",
    name: "Gold Leaf",
    tint: "#fbbf24",
    base: "#0f0b02",
    blobs: [
      ["rgba(251,191,36,0.44)", "28%", "32%", "48%"],
      ["rgba(217,119,6,0.46)", "74%", "66%", "46%"],
      ["rgba(120,53,15,0.55)", "50%", "50%", "64%"],
    ],
  },
  {
    key: "ink",
    name: "Ink",
    tint: "#94a3b8",
    base: "#05070a",
    blobs: [
      ["rgba(148,163,184,0.30)", "26%", "28%", "50%"],
      ["rgba(71,85,105,0.48)", "76%", "68%", "48%"],
      ["rgba(30,41,59,0.60)", "50%", "50%", "62%"],
    ],
  },
];

export function builtinByKey(key) {
  return BUILTIN.find((b) => b.key === key) || null;
}

/** The fixed element every wallpaper is drawn into, created on first use. */
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

function clearLayer(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  el.style.background = "";
  el.style.backgroundImage = "";
}

function setTint(tint) {
  if (!tint) return;
  document.documentElement.style.setProperty("--accent", tint);
}

/** Is this URL a video we should mount as a looping <video>? */
export function looksLikeVideo(url) {
  return /\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(String(url)) || String(url).startsWith("data:video/");
}

function renderBuiltin(el, spec) {
  const def = builtinByKey(spec.key) || BUILTIN[0];
  el.style.background = def.base;
  setTint(def.tint);

  def.blobs.forEach(([color, x, y, size], i) => {
    const blob = document.createElement("div");
    blob.className = `wp-blob wp-blob-${i + 1}`;
    blob.style.background = `radial-gradient(circle at center, ${color} 0%, transparent 70%)`;
    blob.style.left = x;
    blob.style.top = y;
    blob.style.width = size;
    blob.style.height = size;
    el.appendChild(blob);
  });

  // A faint grain layer stops large gradients from banding on OLED screens.
  const grain = document.createElement("div");
  grain.className = "wp-grain";
  el.appendChild(grain);
}

function renderVideo(el, url) {
  const v = document.createElement("video");
  v.className = "wp-media";
  v.src = url;
  v.autoplay = true;
  v.loop = true;
  v.muted = true;
  v.defaultMuted = true;
  v.playsInline = true;
  v.setAttribute("playsinline", "");     // iOS refuses to inline-play without the attribute
  v.setAttribute("muted", "");
  v.setAttribute("disablepictureinpicture", "");
  v.addEventListener("error", () => {
    // A dead link should not leave a black screen - fall back to a built-in.
    clearLayer(el);
    renderBuiltin(el, { key: "aurora" });
  });
  el.appendChild(v);
  const attempt = v.play();
  if (attempt && typeof attempt.catch === "function") attempt.catch(() => {});
}

function renderImage(el, url) {
  const img = document.createElement("div");
  img.className = "wp-media wp-image";
  img.style.backgroundImage = `url("${url}")`;
  el.appendChild(img);
}

/**
 * Draws a wallpaper. `spec` is one of:
 *   { type: "builtin", key }
 *   { type: "url",     url }
 *   { type: "upload",  dataUrl }
 *   { type: "none" }
 */
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
  if (!src) { renderBuiltin(el, { key: "aurora" }); return; }
  if (looksLikeVideo(src)) renderVideo(el, src);
  else renderImage(el, src);
}

// --- persistence -------------------------------------------------------

export function readLocal() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;                      // Safari private mode
  }
}

export function writeLocal(settings) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(settings));
  } catch {
    // storage unavailable - the server copy still holds it
  }
}

export function defaultSettings() {
  return {
    active: { type: "builtin", key: "aurora" },
    library: [],                      // saved { id, label, type, url|dataUrl }
    rotate: false,
    rotateMinutes: 15,
  };
}

/**
 * Cycles the active wallpaper through the built-ins plus anything saved in the
 * library. Returns the next spec; the caller applies and persists it.
 */
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
