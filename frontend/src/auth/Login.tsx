import { useState } from 'react';
import type { FormEvent } from 'react';
import { supabase } from '../supabase';
import { config, isAdminEmail } from '../config';
import { friendlyError } from '../errors';
import Logo from '../components/Logo';

function validEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [sent, setSent] = useState(false);
  const [forgot, setForgot] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const canUseSignInLink =
    config.auth.signInLinkForEveryone || isAdminEmail(email);

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

    const value = email.trim();
    if (!value) {
      setError('Enter your email first.');
      return;
    }
    if (!validEmail(value)) {
      setError('Enter a valid email address.');
      return;
    }

    setBusy(true);
    const { error } = await supabase.auth.signInWithOtp({
      email: value,
      options: { emailRedirectTo: window.location.origin },
    });
    setBusy(false);
    if (error) setError(friendlyError(error.message));
    else setSent(true);
  }

  return (
    <div className="auth">
      <div className="auth-card">
        <Logo size={88} compact />
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

        {canUseSignInLink && (
          <button type="button" className="btn-ghost" disabled={busy} onClick={onMagicLink}>
            Email me a sign-in link instead
          </button>
        )}

        <button
          type="button"
          className="btn-ghost"
          aria-expanded={forgot}
          onClick={() => setForgot((open) => !open)}
        >
          Forgot password?
        </button>
        {forgot && (
          <p className="hint" role="status">
            Password resets aren’t set up yet. Contact Mur Systems and we’ll reset it for you.
          </p>
        )}

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
