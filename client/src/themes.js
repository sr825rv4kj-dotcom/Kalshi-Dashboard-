export const THEMES = {
  aurora: {
    name: 'Aurora Borealis',
    wallpaper: 'conic-gradient(from 45deg, #00ff00, #00ffff, #ff00ff, #00ff00)',
    primary: '#00ff00',
    secondary: '#00ffff',
    accent: '#ff00ff',
    background: '#0a0e27',
    text: '#ffffff',
    cardBg: 'rgba(15, 25, 50, 0.8)'
  },
  ocean: {
    name: 'Ocean Depths',
    wallpaper: 'radial-gradient(circle at 30% 50%, #0066cc 0%, #001a4d 50%, #000000 100%)',
    primary: '#0088ff',
    secondary: '#00ccff',
    accent: '#ffaa00',
    background: '#001f4d',
    text: '#e6f2ff',
    cardBg: 'rgba(0, 30, 80, 0.75)'
  },
  fire: {
    name: 'Inferno',
    wallpaper: 'conic-gradient(from 180deg, #ff0000, #ff6600, #ffcc00, #ff0000)',
    primary: '#ff4400',
    secondary: '#ffaa00',
    accent: '#ffff00',
    background: '#2a1a0a',
    text: '#ffffff',
    cardBg: 'rgba(60, 20, 0, 0.8)'
  },
  forest: {
    name: 'Emerald Forest',
    wallpaper: 'radial-gradient(circle at 60% 40%, #22cc44 0%, #004400 40%, #000000 100%)',
    primary: '#33ff66',
    secondary: '#00cc44',
    accent: '#ffcc00',
    background: '#0d2a0d',
    text: '#e6ffe6',
    cardBg: 'rgba(20, 50, 20, 0.8)'
  },
  sunset: {
    name: 'Golden Sunset',
    wallpaper: 'linear-gradient(135deg, #ff6b00, #ffaa00, #ffee00, #ff6b00)',
    primary: '#ffaa00',
    secondary: '#ffdd66',
    accent: '#ff4400',
    background: '#3d2a1a',
    text: '#fff8e6',
    cardBg: 'rgba(80, 50, 20, 0.8)'
  },
  cyberpunk: {
    name: 'Cyberpunk Neon',
    wallpaper: 'linear-gradient(45deg, #ff006e, #8338ec, #3a86ff, #ff006e)',
    primary: '#ff006e',
    secondary: '#8338ec',
    accent: '#3a86ff',
    background: '#0d0221',
    text: '#ffffff',
    cardBg: 'rgba(30, 10, 50, 0.85)'
  },
  midnight: {
    name: 'Midnight Star',
    wallpaper: 'radial-gradient(circle at random, white 0%, transparent 2%), #000000',
    primary: '#66ccff',
    secondary: '#99ffff',
    accent: '#ffff99',
    background: '#0a0a1a',
    text: '#ccddff',
    cardBg: 'rgba(20, 30, 60, 0.8)'
  },
  lavender: {
    name: 'Lavender Dream',
    wallpaper: 'radial-gradient(circle at 40% 60%, #d8b0ff 0%, #9966ff 30%, #4a148c 100%)',
    primary: '#d8b0ff',
    secondary: '#bb86fc',
    accent: '#ffcc00',
    background: '#1a0a2e',
    text: '#f0e6ff',
    cardBg: 'rgba(60, 30, 90, 0.8)'
  },
  monsoon: {
    name: 'Monsoon Storm',
    wallpaper: 'conic-gradient(from 90deg, #334455, #667788, #aabbcc, #334455)',
    primary: '#4488cc',
    secondary: '#66aaee',
    accent: '#ffee00',
    background: '#1a2a3a',
    text: '#d0e0f0',
    cardBg: 'rgba(30, 50, 80, 0.8)'
  },
  plasma: {
    name: 'Plasma Core',
    wallpaper: 'conic-gradient(from 0deg, #ff0080, #ff8c00, #ffff00, #ff0080)',
    primary: '#ff0080',
    secondary: '#ff8c00',
    accent: '#ffff00',
    background: '#1a0a0a',
    text: '#ffffff',
    cardBg: 'rgba(80, 20, 40, 0.85)'
  }
};

export const THEME_ROTATION = [
  'aurora',
  'ocean',
  'fire',
  'forest',
  'sunset',
  'cyberpunk',
  'midnight',
  'lavender',
  'monsoon',
  'plasma'
];

export function getTodayTheme() {
  const dayOfYear = Math.floor(
    (Date.now() - new Date(new Date().getFullYear(), 0, 0).getTime()) / 86400000
  );
  const themeIndex = dayOfYear % THEME_ROTATION.length;
  const themeName = THEME_ROTATION[themeIndex];
  return THEMES[themeName];
}

export function getTheme(name) {
  return THEMES[name] || THEMES.aurora;
}
