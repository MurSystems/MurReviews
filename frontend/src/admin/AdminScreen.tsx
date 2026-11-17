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
    throw new Error('Could not reach the admin server. Check your connection and try again.');
  }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new Error('Your session has ended. Log in again.');
    }
    if (res.status === 404) throw new Error('That item no longer exists.');
    if (res.status >= 500) {
      throw new Error('The admin server is having trouble. Try again in a moment.');
    }
    throw new Error('The admin server refused that request. Try again.');
  }
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('The admin server sent something we couldn’t read. Try again.');
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : 'Something went wrong. Try again.';
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

function shortDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'wanted';
  return `wanted ${date.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })}`;
}

type Business = {
  id: string;
  name: string;
  status: string;
  send_mode: string;
  texts_sent: number;
  clicks: number;
  gateway_online: boolean;
  owner_email: string | null;
  logo_url: string | null;
  ai_replies_requested_at: string | null;
  texts_used_this_month: number;
  monthly_text_cap: number;
  monthly_state: 'ok' | 'warning' | 'paused';
};

type AuditRow = {
  id: string;
  created_at: string;
  admin_email: string;
  action: string;
  details: unknown;
};

type ActivityData = {
  messages: {
    id: string;
    status: string;
    mock: boolean | null;
    message_text: string | null;
    customers: { first_name: string; mobile: string } | { first_name: string; mobile: string }[] | null;
  }[];
  replies: { id: string; from_mobile: string; body: string }[];
};

type Notice = {
  kind: 'ok' | 'error';
  text: string;
  link?: { label: string; value: string };
};

async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    try {
      const el = document.createElement('textarea');
      el.value = value;
      el.style.position = 'fixed';
      el.style.opacity = '0';
      document.body.appendChild(el);
      el.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(el);
      return ok;
    } catch {
      return false;
    }
  }
}

function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);

  async function onCopy() {
    const ok = await copyText(value);
    setCopied(ok);
    if (ok) setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="copy-row">
      <span className="copy-label">{label}</span>
      <code className="link-text">{value}</code>
      <button type="button" className="btn btn-secondary" onClick={onCopy}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

export default function AdminScreen() {
  const [tab, setTab] = useState<'businesses' | 'demo' | 'audit'>('businesses');
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [placesUsage, setPlacesUsage] = useState<{ rows: { request_count: number }[]; cap: number } | null>(
    null,
  );
  const [viewAs, setViewAs] = useState<{ id: string; name: string } | null>(null);
  const [activity, setActivity] = useState<ActivityData | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [newPlaceId, setNewPlaceId] = useState('');

  function showError(e: unknown) {
    setNotice({ kind: 'error', text: errMsg(e) });
  }

  async function refresh() {
    try {
      setBusinesses((await adminFetch('/admin/businesses')) ?? []);
      setAudit((await adminFetch('/admin/audit')) ?? []);
      setPlacesUsage(await adminFetch('/admin/places-usage'));
    } catch (e) {
      showError(e);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function onCreateBusiness(e: FormEvent) {
    e.preventDefault();
    const form = e.currentTarget as HTMLFormElement;
    const fd = new FormData(form);
    const name = String(fd.get('name') ?? '').trim();
    setNotice(null);
    try {
      const r = await adminFetch('/admin/businesses', 'POST', {
        name,
        place_id: String(fd.get('place_id') ?? '').trim(),
        timezone: String(fd.get('timezone') ?? 'Australia/Melbourne'),
        send_mode: String(fd.get('send_mode') ?? 'android_gateway'),
        delay_minutes: Number(fd.get('delay') ?? 60),
        owner_email: String(fd.get('owner_email') ?? '').trim(),
      });
      form.reset();
      setNewPlaceId('');
      setNotice({
        kind: 'ok',
        text: `Business “${name}” created.`,
        link: r?.login_link ? { label: 'Owner login link', value: r.login_link } : undefined,
      });
      refresh();
    } catch (err) {
      showError(err);
    }
  }

  async function onSetStatus(id: string, status: string) {
    setNotice(null);
    try {
      await adminFetch(`/admin/businesses/${id}/status`, 'POST', { status });
      setNotice({ kind: 'ok', text: `Status set to ${status}.` });
      refresh();
    } catch (err) {
      showError(err);
    }
  }

  async function onSetMonthlyCap(e: FormEvent) {
    e.preventDefault();
    const form = e.currentTarget as HTMLFormElement;
    const fd = new FormData(form);
    const id = String(fd.get('business_id') ?? '');
    const cap = Number(fd.get('monthly_text_cap'));
    setNotice(null);
    try {
      await adminFetch(`/admin/businesses/${id}/monthly-cap`, 'POST', {
        monthly_text_cap: cap,
      });
      setNotice({ kind: 'ok', text: `Monthly allowance set to ${cap} texts.` });
      refresh();
    } catch (err) {
      showError(err);
    }
  }

  async function onSendTestNow(id: string, name: string) {
    setNotice(null);
    try {
      const r = await adminFetch(`/admin/businesses/${id}/send-test-now`, 'POST', {});
      setNotice({
        kind: 'ok',
        text: r?.live
          ? `Live test text sent to ${r.mobile} for ${name}.`
          : `Test recorded for ${name} to ${r.mobile}, but live sending is off (SENDER_LIVE is not true), so no text was sent.`,
      });
    } catch (err) {
      showError(err);
    }
  }

  async function onGenerateLink(e: FormEvent) {
    e.preventDefault();
    const form = e.currentTarget as HTMLFormElement;
    const email = String(new FormData(form).get('email') ?? '').trim();
    setNotice(null);
    try {
      const { link } = await adminFetch('/admin/generate-login-link', 'POST', { email });
      setNotice({ kind: 'ok', text: `Owner login link ready for ${email}.`, link: { label: 'Login link', value: link } });
    } catch (err) {
      showError(err);
    }
  }

  async function onDemoSend(e: FormEvent) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget as HTMLFormElement);
    setNotice(null);
    try {
      const r = await adminFetch('/admin/demo-send', 'POST', {
        place_id: String(fd.get('place_id') ?? '').trim(),
        mobile: String(fd.get('mobile') ?? '').trim(),
      });
      setNotice({
        kind: 'ok',
        text: `Demo send: ${r?.outcome}${r?.demo_text ? ` — “${r.demo_text}”` : ''}`,
      });
    } catch (err) {
      showError(err);
    }
  }

  async function onViewAs(id: string, name: string) {
    setViewAs({ id, name });
    setActivity(null);
    setNotice(null);
    try {
      setActivity(await adminFetch(`/admin/businesses/${id}/activity`));
    } catch (err) {
      showError(err);
    }
  }

  async function onResetPassword(email: string) {
    setNotice(null);
    try {
      const r = await adminFetch('/admin/send-password-reset', 'POST', { email });
      setNotice({
        kind: 'ok',
        text: `Password reset link for ${email}.`,
        link: { label: 'Password reset link', value: r.link },
      });
    } catch (err) {
      showError(err);
    }
  }

  const noticeBox = notice && (
    <div
      className={notice.kind === 'ok' ? 'notice notice-inline' : 'warn'}
      role={notice.kind === 'error' ? 'alert' : 'status'}
    >
      <div className="stack" style={{ gap: 8, flex: 1, minWidth: 0 }}>
        <p style={{ margin: 0 }}>{notice.text}</p>
        {notice.link && <CopyRow label={notice.link.label} value={notice.link.value} />}
      </div>
    </div>
  );

  if (viewAs) {
    return (
      <div className="admin">
        <div className="page page-wide">
          <button className="btn-ghost" onClick={() => setViewAs(null)} type="button">
            ← Back to admin
          </button>
          <header className="screen-head">
            <h1>{viewAs.name}</h1>
            <p className="muted">Viewing this business’s latest activity.</p>
          </header>
          {noticeBox}
          {!activity && <p className="muted">Loading…</p>}
          {activity && (
            <>
              <section className="card">
                <h2>Messages</h2>
                {activity.messages.length === 0 ? (
                  <p className="empty">No messages yet.</p>
                ) : (
                  <ul className="list">
                    {activity.messages.map((m) => {
                      const customer = Array.isArray(m.customers) ? m.customers[0] : m.customers;
                      return (
                        <li key={m.id}>
                          <span className="item-title">
                            {customer?.first_name ?? 'Customer'} ({customer?.mobile ?? '—'})
                            {m.mock ? ' (test)' : ''}
                          </span>
                          <span className="item-sub">
                            {m.status}
                            {m.message_text ? ` · ${m.message_text}` : ''}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
              <section className="screen-section">
                <h2>Replies</h2>
                {activity.replies.length === 0 ? (
                  <p className="empty">No replies yet.</p>
                ) : (
                  <ul className="list">
                    {activity.replies.map((r) => (
                      <li key={r.id}>
                        <span className="item-title">{r.body}</span>
                        <span className="item-sub">{r.from_mobile}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </>
          )}
        </div>
      </div>
    );
  }

  const interested = businesses.filter((b) => b.ai_replies_requested_at).length;

  return (
    <div className="admin">
      <div className="page page-wide">
        <header className="screen-head">
          <h1>Admin</h1>
          <p className="muted">Manage businesses, demo sends and the audit log.</p>
        </header>

        {noticeBox}

        <nav className="subnav" aria-label="Admin sections">
          {(['businesses', 'demo', 'audit'] as const).map((t) => (
            <button
              key={t}
              type="button"
              className={tab === t ? 'active' : undefined}
              aria-current={tab === t ? 'page' : undefined}
              onClick={() => setTab(t)}
            >
              {t[0].toUpperCase() + t.slice(1)}
            </button>
          ))}
        </nav>

        {tab === 'businesses' && (
          <>
            <form onSubmit={onCreateBusiness} className="card">
              <h2>Create business</h2>
              <label className="field">
                <span>Business name</span>
                <input name="name" placeholder="e.g. Harbour Dental" required />
              </label>
              <label className="field">
                <span>Google Place ID</span>
                <input
                  name="place_id"
                  placeholder="ChIJ…"
                  required
                  value={newPlaceId}
                  onChange={(e) => setNewPlaceId(e.target.value)}
                />
              </label>
              <p className="field-note">
                <a href={PLACE_ID_FINDER} target="_blank" rel="noreferrer">
                  Find a Place ID ↗
                </a>
              </p>
              {newPlaceId && <CopyRow label="Review link preview" value={reviewLink(newPlaceId)} />}
              <label className="field">
                <span>Timezone</span>
                <input name="timezone" defaultValue="Australia/Melbourne" />
              </label>
              <label className="field">
                <span>Send mode</span>
                <select name="send_mode" defaultValue="android_gateway">
                  <option value="android_gateway">Android gateway (SMSGate)</option>
                  <option value="sms_provider">SMS provider (Mobile Message)</option>
                  <option value="demo">Demo (no real text)</option>
                  <option value="log_only">Log only (no real text)</option>
                </select>
              </label>
              <label className="field">
                <span>Review request delay (minutes)</span>
                <input name="delay" type="number" min={0} defaultValue={60} />
              </label>
              <label className="field">
                <span>Owner email</span>
                <input name="owner_email" type="email" placeholder="owner@business.com" required />
              </label>
              <button type="submit" className="btn btn-primary">
                Create business
              </button>
            </form>

            <section className="screen-section">
              <h2>Businesses</h2>
              <p className="muted" style={{ marginTop: 0 }}>
                {businesses.length} total · {interested} want AI replies.
              </p>
              <p className="muted" style={{ marginTop: 0 }}>
                Send test now texts the allowlisted number immediately, ignoring quiet hours and the
                delay. It is not counted in usage or stats.
              </p>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Status</th>
                      <th>Mode</th>
                      <th>Sent</th>
                      <th>Clicks</th>
                      <th>This month</th>
                      <th>Allowance</th>
                      <th>Gateway</th>
                      <th>AI replies</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {businesses.map((b) => (
                      <tr key={b.id}>
                        <td>
                          <span className="row">
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
                        <td>
                          <span className="row">
                            <span>
                              {b.texts_used_this_month} / {b.monthly_text_cap}
                            </span>
                            {b.monthly_state === 'paused' && (
                              <span className="pill">paused</span>
                            )}
                            {b.monthly_state === 'warning' && (
                              <span className="pill">80%</span>
                            )}
                          </span>
                        </td>
                        <td>
                          <form onSubmit={onSetMonthlyCap} className="row">
                            <input type="hidden" name="business_id" value={b.id} />
                            <input
                              name="monthly_text_cap"
                              type="number"
                              min={0}
                              step={1}
                              defaultValue={b.monthly_text_cap}
                              aria-label={`Monthly allowance for ${b.name}`}
                              style={{ width: 80 }}
                            />
                            <button className="ghost" type="submit">
                              Save
                            </button>
                          </form>
                        </td>
                        <td>{b.gateway_online ? 'online' : 'offline'}</td>
                        <td>
                          {b.ai_replies_requested_at ? (
                            <span className="pill">{shortDate(b.ai_replies_requested_at)}</span>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                        <td>
                          <span className="row">
                            <button className="ghost" type="button" onClick={() => onSetStatus(b.id, 'active')}>
                              Active
                            </button>
                            <button className="ghost" type="button" onClick={() => onSetStatus(b.id, 'paused')}>
                              Pause
                            </button>
                            <button className="ghost" type="button" onClick={() => onSetStatus(b.id, 'trial')}>
                              Trial
                            </button>
                            <button className="ghost" type="button" onClick={() => onViewAs(b.id, b.name)}>
                              View
                            </button>
                            <button
                              className="ghost"
                              type="button"
                              onClick={() => onSendTestNow(b.id, b.name)}
                            >
                              Send test now
                            </button>
                            {b.owner_email && (
                              <button
                                className="ghost"
                                type="button"
                                onClick={() => onResetPassword(b.owner_email as string)}
                              >
                                Reset pw
                              </button>
                            )}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}

        {tab === 'demo' && (
          <form onSubmit={onDemoSend} className="card">
            <h2>Demo send</h2>
            <p className="muted" style={{ margin: 0 }}>
              Texts a sample review request to a prospect’s mobile.
            </p>
            <label className="field">
              <span>Prospect Place ID</span>
              <input name="place_id" placeholder="ChIJ…" required />
            </label>
            <label className="field">
              <span>Prospect mobile</span>
              <input name="mobile" type="tel" placeholder="0491 570 006" required />
            </label>
            <button type="submit" className="btn btn-primary">
              Send demo
            </button>
          </form>
        )}

        {tab === 'audit' && (
          <>
            <form onSubmit={onGenerateLink} className="card">
              <h2>Generate owner login link</h2>
              <label className="field">
                <span>Owner email</span>
                <input name="email" type="email" placeholder="owner@business.com" required />
              </label>
              <button type="submit" className="btn btn-primary">
                Generate link
              </button>
            </form>

            <section className="card screen-section">
              <h2>Places API usage this month</h2>
              <p className="stat-value" style={{ margin: 0 }}>
                {placesUsage?.rows?.[0]?.request_count ?? 0}
                <span className="muted" style={{ fontSize: 16, fontWeight: 400 }}>
                  {' '}
                  / {placesUsage?.cap ?? 900}
                </span>
              </p>
            </section>

            <section className="screen-section">
              <h2>Audit log</h2>
              {audit.length === 0 ? (
                <p className="empty">No admin actions recorded yet.</p>
              ) : (
                <ul className="list">
                  {audit.map((a) => (
                    <li key={a.id}>
                      <span className="item-title">
                        {a.action} — {a.admin_email}
                      </span>
                      <span className="item-sub">
                        {new Date(a.created_at).toLocaleString()} · {JSON.stringify(a.details)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
