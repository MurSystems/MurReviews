import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';
import { config } from './config';

// Inject theme colours from the single config file as CSS variables.
const t = config.theme;
const rootEl = document.documentElement;
rootEl.style.setProperty('--bg', t.background);
rootEl.style.setProperty('--surface', t.surface);
rootEl.style.setProperty('--text', t.text);
rootEl.style.setProperty('--text-muted', t.textMuted);
rootEl.style.setProperty('--border', t.border);
rootEl.style.setProperty('--accent', t.accent);
rootEl.style.setProperty('--accent-contrast', t.accentContrast);
rootEl.style.setProperty('--danger', t.danger);
rootEl.style.setProperty('--success', t.success);
document.title = config.product;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
