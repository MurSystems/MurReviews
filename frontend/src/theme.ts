// Light/dark follows the device until the user picks a theme; after that the
// choice is saved on this device only (localStorage `mur-theme`).
export type Theme = 'light' | 'dark';

const KEY = 'mur-theme';
const COLOURS: Record<Theme, string> = { light: '#f4efe6', dark: '#0c0c0c' };
const listeners = new Set<(theme: Theme) => void>();

function systemTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function getSavedTheme(): Theme | null {
  try {
    const saved = localStorage.getItem(KEY);
    return saved === 'light' || saved === 'dark' ? saved : null;
  } catch {
    return null;
  }
}

export function getTheme(): Theme {
  return getSavedTheme() ?? systemTheme();
}

export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle('dark', theme === 'dark');
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', COLOURS[theme]);
}

function notify(): void {
  const theme = getTheme();
  for (const listener of listeners) listener(theme);
}

export function onThemeChange(listener: (theme: Theme) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function saveTheme(theme: Theme): void {
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // Storage unavailable — the choice lasts for this visit only.
  }
  applyTheme(theme);
  notify();
}

// Apply the device theme on load, and keep following it until the user picks.
export function initTheme(): void {
  applyTheme(getTheme());
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (getSavedTheme()) return;
    applyTheme(systemTheme());
    notify();
  });
}
