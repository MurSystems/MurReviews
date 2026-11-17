import { useState } from 'react';
import type { FormEvent } from 'react';
import { supabase } from '../supabase';
import { config } from '../config';

export default function Login() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
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
      <form className="card" onSubmit={onSubmit}>
        <h1>{config.product}</h1>
        <p className="muted">Log in with a magic link.</p>
        {sent ? (
          <p className="ok">Sent! Check {email} and tap the link to log in.</p>
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
            <button type="submit" disabled={busy}>
              {busy ? 'Sending…' : 'Send magic link'}
            </button>
          </>
        )}
        {error && <p className="error">{error}</p>}
      </form>
    </div>
  );
}
