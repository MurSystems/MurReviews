import { saveTheme } from '../theme';
import { useTheme } from '../useTheme';

function SunIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

// Small sun/moon switch for the login page and the app header.
export default function ThemeToggle() {
  const theme = useTheme();
  const isDark = theme === 'dark';

  return (
    <button
      type="button"
      className="theme-toggle"
      role="switch"
      aria-checked={isDark}
      aria-label="Dark mode"
      title={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
      onClick={() => saveTheme(isDark ? 'light' : 'dark')}
    >
      <span className={isDark ? 'theme-icon' : 'theme-icon active'}>
        <SunIcon />
      </span>
      <span className={isDark ? 'theme-icon active' : 'theme-icon'}>
        <MoonIcon />
      </span>
    </button>
  );
}
