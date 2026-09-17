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
  }
};
export const THEME_ROTATION = ['aurora', 'ocean'];
export function getTodayTheme() {
  const dayOfYear = Math.floor(
    (Date.now() - new Date(new Date().getFullYear(), 0, 0).getTime()) / 86400000
  );
  return THEMES[THEME_ROTATION[dayOfYear % THEME_ROTATION.length]];
}
export function getTheme(name) {
  return THEMES[name] || THEMES.aurora;
}
