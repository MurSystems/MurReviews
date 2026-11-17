import { friendlyError } from './errors';

// A failed auth link (expired or already used) redirects back with the reason
// in the URL fragment. Read it once, then clear it so a refresh doesn't repeat
// the same message.
export function takeAuthLinkError(): string {
  if (typeof window === 'undefined') return '';
  const raw = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : '';
  if (!raw) return '';

  const params = new URLSearchParams(raw);
  const code = params.get('error_code');
  const description = params.get('error_description');
  if (!code && !description) return '';

  const url = new URL(window.location.href);
  url.hash = '';
  window.history.replaceState(window.history.state, '', url.toString());
  return friendlyError(description || code);
}

export function isSetPasswordPath(): boolean {
  return window.location.pathname.replace(/\/+$/, '') === '/set-password';
}
