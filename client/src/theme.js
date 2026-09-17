/**
 * theme.js
 *
 * Palette variants that sit on top of the iOS-style base in index.css.
 * All of them keep the same structure - system typeface, grouped cards,
 * hairline separators - and vary only the accent and field tones.
 */

const THEMES = {
  daylight: {
    name: "Daylight",
    vars: {
      "--field": "#f2f2f7",
      "--card": "#ffffff",
      "--label": "#1c1c1e",
      "--blue": "#007aff",
      "--green": "#34c759",
      "--red": "#ff3b30",
      "--orange": "#ff9500",
    },
  },
  graphite: {
    name: "Graphite",
    vars: {
      "--field": "#eceff3",
      "--card": "#ffffff",
      "--label": "#11161d",
      "--blue": "#3a5a8c",
      "--green": "#2f9e63",
      "--red": "#d1453b",
      "--orange": "#c47d1a",
    },
  },
  dusk: {
    name: "Dusk",
    vars: {
      "--field": "#1c1c1e",
      "--card": "#2c2c2e",
      "--label": "#f2f2f7",
      "--label-secondary": "rgba(235, 235, 245, 0.6)",
      "--label-tertiary": "rgba(235, 235, 245, 0.3)",
      "--separator": "rgba(235, 235, 245, 0.2)",
      "--fill": "rgba(120, 120, 128, 0.24)",
      "--blue": "#0a84ff",
      "--green": "#30d158",
      "--red": "#ff453a",
      "--orange": "#ff9f0a",
    },
  },
};

export const THEME_KEYS = Object.keys(THEMES);

export function getTheme(key) {
  return THEMES[key] ? { key, ...THEMES[key] } : { key: "daylight", ...THEMES.daylight };
}

export function getTodaysTheme() {
  // Safari throws a SecurityError on localStorage access when site data is
  // blocked or in Private Browsing - a `typeof` check is not enough. This
  // runs inside a useState initializer, so an uncaught throw here takes the
  // whole app down to a white screen.
  let saved = null;
  try {
    saved = localStorage.getItem("kalshi_theme");
  } catch {
    saved = null;
  }
  if (saved && THEMES[saved]) return { key: saved, ...THEMES[saved] };
  return { key: "daylight", ...THEMES.daylight };
}

export function setTheme(key) {
  try {
    localStorage.setItem("kalshi_theme", key);
  } catch {
    // Preference just won't persist - not worth breaking the app over.
  }
  return getTheme(key);
}

export function applyTheme(theme) {
  const root = document.documentElement;
  // Clear any vars a previous theme set that this one doesn't, so switching
  // never leaves a stale value behind.
  for (const t of Object.values(THEMES)) {
    for (const prop of Object.keys(t.vars)) root.style.removeProperty(prop);
  }
  for (const [prop, value] of Object.entries(theme.vars)) {
    root.style.setProperty(prop, value);
  }
}
