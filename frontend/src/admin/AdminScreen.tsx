import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { supabase } from '../supabase';
import { config } from '../config';

const WORKER = config.workerUrl;

async function adminFetch(path: string, method = 'GET', body?: unknown) {
  let res: Response;
  try {
    const { data } = await supabase.auth.getSession();
    const jwt = data.session?.access_token;
    res = await fetch(`${WORKER}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwt}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error(
      'Could not reach the admin server. Check the Worker is deployed and CORS is enabled.',
    );
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`Admin server error (${res.status}): ${text}`);
  return text ? JSON.parse(text) : null;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const PLACE_ID_FINDER = 'https://developers.google.com/maps/documentation/places/web-service/place-id';

function reviewLink(placeId: string) {
  return `https://search.google.com/local/writereview?placeid=${encodeURIComponent(placeId)}`;
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

export default function AdminScreen() {
  const [tab, setTab] = useState<'businesses' | 'demo' | 'audit'>('businesses');
  const [businesses, setBusinesses] = useState<any[]>([]);
  const [audit, setAudit] = useState<any[]>([]);
  const [placesUsage, setPlacesUsage] = useState<{ rows: any[]; cap: number } | null>(null);
  const [viewAs, setViewAs] = useState<{ id: string; name: string } | null>(null);
  const [activity, setActivity] = useState<{ messages: any[]; replies: any[] } | null>(null);
  const [msg, setMsg] = useState('');
  const [newPlaceId, setNewPlaceId] = useState('');

  useEffect(() => {
    refresh();
  }, []);

  async function refresh() {
    try {
      setBusinesses((await adminFetch('/admin/businesses')) ?? []);
      setAudit((await adminFetch('/admin/audit')) ?? []);
      setPlacesUsage(await adminFetch('/admin/places-usage'));
    } catch (e) {
      setMsg(errMsg(e));
    }
  }

  async function onCreateBusiness(e: FormEvent) {
    e.preventDefault();
    const f = e.currentTarget as any;
    setMsg('');
    try {
      const r = await adminFetch('/admin/businesses', 'POST', {
        name: f.name.value,
        place_id: f.place_id.value,
        timezone: f.timezone.value || 'Australia/Melbourne',
        send_mode: f.send_mode.value,
        delay_minutes: Number(f.delay.value || 60),
        owner_email: f.owner_email.value,
      });
      f.reset();
      setMsg(
        r?.login_link
          ? `Business created. Owner login link: ${r.login_link}`
          : 'Business created.',
      );
      refresh();    } catch (err) {
      setMsg(errMsg(err));
    }
  }

  async function onSetStatus(id: string, status: string) {
    setMsg('');
    try {
      await adminFetch(`/admin/businesses/${id}/status`, 'POST', { status });
      setMsg(`Status set to ${status}.`);
      refresh();
    } catch (err) {
      setMsg(errMsg(err));
    }
  }

  async function onGenerateLink(e: FormEvent) {
    e.preventDefault();
    const f = e.currentTarget as any;
    setMsg('');
    try {
      const { link } = await adminFetch('/admin/generate-login-link', 'POST', {
        email: f.email.value,
      });
      setMsg(`Login link: ${link}`);
    } catch (err) {
      setMsg(errMsg(err));
    }
  }

  async function onDemoSend(e: FormEvent) {
    e.preventDefault();
    const f = e.currentTarget as any;
    setMsg('');
    try {
      const r = await adminFetch('/admin/demo-send', 'POST', {
        place_id: f.place_id.value,
        mobile: f.mobile.value,
      });
      setMsg(`Demo send: ${r?.outcome}${r?.demo_text ? ` — "${r.demo_text}"` : ''}`);
    } catch (err) {
      setMsg(errMsg(err));
    }
  }

  async function onViewAs(id: string, name: string) {
    setViewAs({ id, name });
    setActivity(null);
    try {
      setActivity(await adminFetch(`/admin/businesses/${id}/activity`));
    } catch (err) {
      setMsg(errMsg(err));
    }
  }

  async function onResetPassword(email: string) {
    setMsg('');
    try {
      const r = await adminFetch('/admin/send-password-reset', 'POST', { email });
      setMsg(`Password reset link: ${r.link}`);
    } catch (err) {
      setMsg(errMsg(err));
    }
  }

  if (viewAs) {
    return (
      <div>
        <button className="ghost" onClick={() => setViewAs(null)}>← Back</button>
        <h1>View as: {viewAs.name}</h1>
        {!activity && <p className="muted">Loading…</p>}
        {activity && (
          <>
            <h2>Messages</h2>
            <ul>
              {activity.messages.map((m: any) => (
                <li key={m.id}>
                  {m.customers?.first_name} ({m.customers?.mobile}) — {m.status}
                  {m.mock ? ' (test)' : ''}
                  {m.message_text ? `: ${m.message_text}` : ''}
                </li>
              ))}
            </ul>
            <h2>Replies</h2>
            <ul>
              {activity.replies.map((r: any) => (
                <li key={r.id}>{r.from_mobile}: {r.body}</li>
              ))}
            </ul>
          </>
        )}
      </div>
    );
  }

  return (
    <div>
      <h1>Admin</h1>
      {msg && <p className="warn">{msg}</p>}

      <div className="tabbar" style={{ marginBottom: 12 }}>
        {(['businesses', 'demo', 'audit'] as const).map((t) => (
          <button key={t} className={tab === t ? 'tab active' : 'tab'} onClick={() => setTab(t)}>
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {tab === 'businesses' && (
        <>
          <form onSubmit={onCreateBusiness} className="card" style={{ maxWidth: 'none' }}>
            <h2>Create business</h2>
            <input name="name" placeholder="Business name" required />
            <div>
              <input name="place_id" placeholder="Google Place ID" required value={newPlaceId} onChange={(e) => setNewPlaceId(e.target.value)} />
              <a href={PLACE_ID_FINDER} target="_blank" rel="noreferrer" style={{ fontSize: 14 }}>
                Place ID finder ↗
              </a>
              {newPlaceId && (
                <>
                  {' '}
                  <a href={reviewLink(newPlaceId)} target="_blank" rel="noreferrer" style={{ fontSize: 14 }}>
                    review link preview ↗
                  </a>
                </>
              )}
            </div>
            <input name="timezone" placeholder="Timezone" defaultValue="Australia/Melbourne" />
            <select name="send_mode" defaultValue="sms_provider">
              <option value="sms_provider">sms_provider</option>
              <option value="android_gateway">android_gateway</option>
              <option value="demo">demo</option>
              <option value="log_only">log_only</option>
            </select>
            <input name="delay" type="number" placeholder="Delay (minutes)" defaultValue={60} />
            <input name="owner_email" type="email" placeholder="Owner email" required />
            <button type="submit">Create</button>
          </form>

          <h2>Businesses</h2>
          <table style={{ width: '100%', fontSize: 14, borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th>Name</th><th>Status</th><th>Mode</th><th>Sent</th><th>Clicks</th>
                <th>Gateway</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {businesses.map((b) => (
                <tr key={b.id}>
                  <td>
                    <span className="brand">
                      {b.logo_url ? (
                        <img className="badge" src={b.logo_url} alt="" />
                      ) : (
                        <span className="badge">{initials(b.name)}</span>
                      )}
                      {b.name}
                    </span>
                  </td>
                  <td>{b.status}</td>
                  <td>{b.send_mode}</td>
                  <td>{b.texts_sent}</td>
                  <td>{b.clicks}</td>
                  <td>{b.gateway_online ? 'online' : 'offline'}</td>
                  <td>
                    <button className="ghost" onClick={() => onSetStatus(b.id, 'active')}>Active</button>
                    <button className="ghost" onClick={() => onSetStatus(b.id, 'paused')}>Pause</button>
                    <button className="ghost" onClick={() => onSetStatus(b.id, 'trial')}>Trial</button>
                    <button className="ghost" onClick={() => onViewAs(b.id, b.name)}>View</button>
                    {b.owner_email && (
                      <button className="ghost" onClick={() => onResetPassword(b.owner_email)}>Reset pw</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {tab === 'demo' && (
        <form onSubmit={onDemoSend} className="card" style={{ maxWidth: 'none' }}>
          <h2>Demo send</h2>
          <input name="place_id" placeholder="Prospect Place ID" required />
          <input name="mobile" type="tel" placeholder="Prospect mobile (e.g. 0491 570 006)" required />
          <button type="submit">Send demo</button>
        </form>
      )}

      {tab === 'audit' && (
        <>
          <form onSubmit={onGenerateLink} className="card" style={{ maxWidth: 'none' }}>
            <h2>Generate owner login link</h2>
            <input name="email" type="email" placeholder="Owner email" required />
            <button type="submit">Generate link</button>
          </form>

          <h2>Places API usage</h2>
          <p>
            Used this month: <strong>{placesUsage?.rows?.[0]?.request_count ?? 0}</strong> / {placesUsage?.cap ?? 900}
          </p>

          <h2>Audit log</h2>
          <ul>
            {audit.map((a) => (
              <li key={a.id}>
                {new Date(a.created_at).toLocaleString()} — {a.admin_email} — {a.action}{' '}
                {JSON.stringify(a.details)}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
