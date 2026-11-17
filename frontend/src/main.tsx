import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';
import { config } from './config';
import { initTheme } from './theme';

// Apply the saved choice, or follow the device until the user picks one.
initTheme();

// Inject the brand colours from the single config file as CSS variables.
const t = config.theme;
const rootEl = document.documentElement;
rootEl.style.setProperty('--black', t.black);
rootEl.style.setProperty('--gold', t.gold);
rootEl.style.setProperty('--ivory', t.ivory);
rootEl.style.setProperty('--ink', t.ink);
document.title = config.product;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
