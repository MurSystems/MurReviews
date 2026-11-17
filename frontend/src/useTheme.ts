import { useEffect, useState } from 'react';
import { getTheme, onThemeChange } from './theme';
import type { Theme } from './theme';

// The current theme, kept in sync with the header/login toggle and the device
// setting while the user hasn't chosen one.
export function useTheme(): Theme {
  const [theme, setTheme] = useState<Theme>(getTheme);
  useEffect(() => onThemeChange(setTheme), []);
  return theme;
}
