import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { supabase } from '../supabase';
import { friendlyError } from '../errors';
import { config } from '../config';

type Status = {
  configured: boolean;
  connected: boolean;
  last_seen_at: string | null;
};

function formatSeen(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('en-AU', {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export default function PhoneGateway({ businessId }: { businessId: string }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [deviceId, setDeviceId] = useState('');
  const [mobile, setMobile] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(
    null,
  );

  const loadStatus = useCallback(async () => {
    const { data, error } = await supabase.rpc('get_gateway_status', {
      p_business_id: businessId,
    });
    if (!error) setStatus((data?.[0] as Status) ?? null);
  }, [businessId]);

  useEffect(() => {
    void loadStatus();
    const timer = setInterval(loadStatus, 60_000);
    return () => clearInterval(timer);
  }, [loadStatus]);

  async function onSave(e: FormEvent) {
    e.preventDefault();
    setNotice(null);
    if (!username.trim() || !password) {
      setNotice({ kind: 'error', text: 'Enter the SMS Gateway username and password.' });
      return;
    }
    setBusy(true);
    const { error } = await supabase.rpc('save_gateway_credentials', {
      p_business_id: businessId,
      p_username: username.trim(),
      p_password: password,
      p_device_id: deviceId.trim() || null,
    });
    setBusy(false);
    if (error) {
      setNotice({ kind: 'error', text: friendlyError(error.message) });
      return;
    }
    setPassword('');
    setNotice({
      kind: 'ok',
      text: 'Saved. We’ll show Connected once your phone checks in.',
    });
    loadStatus();
  }

  async function onTest() {
    setNotice(null);
    setBusy(true);
    try {
      const { data } = await supabase.auth.getSession();
      const jwt = data.session?.access_token;
      const res = await fetch(`${config.workerUrl}/gateway/test`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${jwt}`,
        },
        body: JSON.stringify({ business_id: businessId, mobile: mobile.trim() }),
      });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        const messages: Record<string, string> = {
          invalid_mobile: 'Enter an Australian mobile starting with 04.',
          not_allowlisted: 'That number isn’t allowed while Mur Reviews is in test mode.',
          not_connected: 'Save your phone details first.',
          rate_limited: 'Too many test texts. Wait a while and try again.',
          send_failed: 'Your phone didn’t accept the text. Check it’s online and try again.',
        };
        setNotice({
          kind: 'error',
          text: messages[body?.error ?? ''] ?? 'Couldn’t send the test text. Try again.',
        });
        return;
      }
      setNotice({ kind: 'ok', text: 'Test text sent. Check your phone.' });
      loadStatus();
    } catch {
      setNotice({ kind: 'error', text: 'Can’t reach the server. Check your connection and try again.' });
    } finally {
      setBusy(false);
    }
  }

  const statusText = !status?.configured
    ? 'Not connected'
    : status.connected
      ? 'Connected'
      : 'Offline';

  return (
    <section className="card screen-section">
      <h2>Connect your phone</h2>
      <p className="muted" style={{ margin: 0 }}>
        Send review texts from your own Android phone with the SMS Gateway app. Keep the
        phone on and connected to the internet.
      </p>

      <p style={{ margin: 0 }}>
        <span className="pill" role="status">
          {statusText}
        </span>
        {status?.configured && status.last_seen_at && (
          <span className="hint"> Last seen {formatSeen(status.last_seen_at)}</span>
        )}
      </p>

      {notice && (
        <p
          className={notice.kind === 'ok' ? 'ok' : 'error'}
          role={notice.kind === 'ok' ? 'status' : 'alert'}
        >
          {notice.text}
        </p>
      )}

      <form onSubmit={onSave} className="stack">
        <p className="hint" style={{ margin: 0 }}>
          In SMS Gateway for Android open Settings → Cloud server. Copy the username and
          password shown there.
        </p>
        <label className="field">
          <span>SMS Gateway username</span>
          <input
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
          />
        </label>
        <label className="field">
          <span>SMS Gateway password</span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <label className="field">
          <span>Device ID (optional)</span>
          <input value={deviceId} onChange={(e) => setDeviceId(e.target.value)} />
        </label>
        <p className="field-note">
          Add the Device ID to show Connected and to receive STOP replies.
        </p>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save connection'}
        </button>
      </form>

      <div className="stack" style={{ marginTop: 18 }}>
        <label className="field">
          <span>Your mobile number (for the test text)</span>
          <input
            type="tel"
            inputMode="numeric"
            autoComplete="tel"
            placeholder="0412 345 678"
            value={mobile}
            onChange={(e) => setMobile(e.target.value)}
          />
        </label>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={busy || !status?.configured || !mobile.trim()}
          onClick={onTest}
        >
          Send test text
        </button>
        {!status?.configured && (
          <p className="hint" style={{ margin: 0 }}>
            Save your phone details first.
          </p>
        )}
      </div>
    </section>
  );
}
