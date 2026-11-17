import { useState } from 'react';
import type { FormEvent } from 'react';
import { supabase } from '../supabase';
import { config } from '../config';
import Logo from '../components/Logo';

function friendlyError(message: string): string {
  if (/invalid login credentials/i.test(message)) {
    return 'That email and password don’t match. Check them and try again.';
  }
  if (/email not confirmed/i.test(message)) {
    return 'Confirm your email first — open the link we sent you.';
  }
  if (/rate limit|too many/i.test(message)) {
    return 'Too many attempts. Wait a minute and try again.';
  }
  return message;
}

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmitPassword(e: FormEvent) {
    e.preventDefault();
    setError('');
    setSent(false);
    setBusy(true);
    const { error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    setBusy(false);
    if (error) setError(friendlyError(error.message));
  }

  async function onMagicLink() {
    setError('');
    setSent(false);
    setBusy(true);
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: window.location.origin },
    });
    setBusy(false);
    if (error) setError(friendlyError(error.message));
    else setSent(true);
  }

  return (
    <div className="auth dark">
      <div className="auth-card">
        <Logo size={88} />
        <h1 className="auth-title">{config.product}</h1>
        <p className="auth-byline">{config.byline}</p>

        <form onSubmit={onSubmitPassword}>
          <label className="field">
            <span>Email</span>
            <input
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </label>
          <label className="field">
            <span>Password</span>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>
          <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
            {busy ? 'Logging in…' : 'Log in'}
          </button>
        </form>

        <button type="button" className="btn-ghost" disabled={busy} onClick={onMagicLink}>
          Email me a sign-in link instead
        </button>

        {sent && (
          <p className="ok" role="status">
            Sign-in link sent to {email}. Open it on this device.
          </p>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
