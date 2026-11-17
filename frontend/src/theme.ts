// Light is the default everywhere; dark is the original black-and-gold look.
// The choice is saved per device, so it follows this browser, not the account.
export type Theme = 'light' | 'dark';

const KEY = 'mur-theme';
const COLOURS: Record<Theme, string> = { light: '#f4efe6', dark: '#0c0c0c' };

export function getTheme(): Theme {
  try {
    return localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle('dark', theme === 'dark');
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', COLOURS[theme]);
}

export function saveTheme(theme: Theme): void {
  applyTheme(theme);
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // Storage unavailable — the choice lasts for this visit only.
  }
}
