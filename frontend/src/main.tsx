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

// A service worker is required for Chrome's install prompt. It does no
// caching, so every visit still gets the latest deploy.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Installation stays unavailable; the app keeps working in the browser.
    });
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
