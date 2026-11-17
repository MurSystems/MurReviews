import { useState } from 'react';
import type { FormEvent } from 'react';
import { supabase } from '../supabase';
import { config } from '../config';
import { friendlyError } from '../errors';
import Logo from '../components/Logo';
import ThemeToggle from '../components/ThemeToggle';

type Props = {
  hasSession: boolean;
  linkError: string;
  onDone: () => void;
};

export default function SetPassword({ hasSession, linkError, onDone }: Props) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const blocked =
    linkError ||
    (hasSession ? '' : 'This link is no longer valid. Ask Mur Systems for a new one.');

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');

    if (password.length < 8) {
      setError('Use at least 8 characters.');
      return;
    }
    if (password !== confirm) {
      setError('The passwords don’t match.');
      return;
    }

    setBusy(true);
    const { error: updErr } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (updErr) {
      setError(friendlyError(updErr.message));
      return;
    }
    onDone();
  }

  return (
    <div className="auth">
      <div className="auth-top">
        <ThemeToggle />
      </div>
      <div className="auth-card">
        <Logo size={88} compact />
        <h1 className="auth-title">Set your password</h1>
        <p className="auth-byline">{config.product}</p>

        {blocked ? (
          <>
            <p className="error" role="alert">
              {blocked}
            </p>
            <button type="button" className="btn-ghost" onClick={onDone}>
              Back to login
            </button>
          </>
        ) : (
          <form onSubmit={onSubmit}>
            <label className="field">
              <span>New password</span>
              <input
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                minLength={8}
                required
              />
            </label>
            <label className="field">
              <span>Confirm new password</span>
              <input
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                minLength={8}
                required
              />
            </label>
            <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
              {busy ? 'Saving…' : 'Save password and open the app'}
            </button>
          </form>
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
