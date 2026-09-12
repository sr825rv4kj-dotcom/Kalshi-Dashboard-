const THEMES = {
  ledger: {
    name: "Ledger",
    vars: {
      "--bg": "#0b0f14",
      "--panel": "#121821",
      "--panel-border": "#202a35",
      "--text": "#e7ecef",
      "--muted": "#7c8a99",
      "--positive": "#3ed598",
      "--negative": "#ff6b5e",
      "--accent": "#f5a623",
      "--heading-font": "'Fraunces', serif",
      "--heading-weight": "600",
      "--heading-transform": "none",
      "--heading-letter-spacing": "-0.01em",
      "--panel-radius": "6px",
    },
  },
  hypebeast: {
    name: "Hypebeast",
    vars: {
      "--bg": "#0a0a0a",
      "--panel": "#161616",
      "--panel-border": "#2e2e2e",
      "--text": "#f5f5f0",
      "--muted": "#8a8a85",
      "--positive": "#c9ff3d",
      "--negative": "#ff3d5a",
      "--accent": "#ff3d5a",
      "--heading-font": "'Inter', sans-serif",
      "--heading-weight": "900",
      "--heading-transform": "uppercase",
      "--heading-letter-spacing": "0.02em",
      "--panel-radius": "2px",
    },
  },
};

export function getTodaysTheme() {
  const now = new Date();
  const startOfYear = new Date(now.getFullYear(), 0, 0);
  const dayOfYear = Math.floor((now - startOfYear) / 86400000);
  const key = dayOfYear % 2 === 0 ? "ledger" : "hypebeast";
  return { key, ...THEMES[key] };
}

export function applyTheme(theme) {
  const root = document.documentElement;
  for (const [prop, value] of Object.entries(theme.vars)) {
    root.style.setProperty(prop, value);
  }
}
