import { useState } from 'react';
import type { FormEvent } from 'react';
import { supabase } from '../supabase';
import { config } from '../config';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmitPassword(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    const { error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    setBusy(false);
    if (error) setError(error.message);
  }

  async function onMagicLink(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: window.location.origin },
    });
    setBusy(false);
    if (error) setError(error.message);
    else setSent(true);
  }

  return (
    <div className="center">
      <form className="card" onSubmit={onSubmitPassword}>
        <h1>{config.product}</h1>
        <p className="muted">Log in to {config.brand}.</p>
        {sent ? (
          <p className="ok">Magic link sent to {email} — tap it to log in.</p>
        ) : (
          <>
            <input
              type="email"
              autoComplete="email"
              placeholder="you@business.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <input
              type="password"
              autoComplete="current-password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            <button type="submit" disabled={busy}>
              {busy ? 'Logging in…' : 'Log in'}
            </button>
            <button
              type="button"
              className="ghost"
              disabled={busy}
              onClick={onMagicLink}
            >
              Email me a magic link instead
            </button>
          </>
        )}
        {error && <p className="error">{error}</p>}
      </form>
    </div>
  );
}
