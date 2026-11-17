import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { supabase } from '../supabase';
import { config } from '../config';
import { OWN_PHONE_REPLY_NOTE, repliesReachApp } from '../replies';

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
    // The Worker sends a plain-language `error` for anything it can explain
    // (allowlist, rate limit, provider rejection, database trouble). Prefer it
    // over a generic fallback so the admin sees the real reason.
    let reason: string | null = null;
    try {
      const data = await res.json();
      if (data && typeof data.error === 'string' && data.error.trim()) {
        reason = data.error.trim();
      }
    } catch {
      // no JSON body
    }
    if (res.status === 401 || (res.status === 403 && !reason)) {
      throw new Error('Your session has ended. Log in again.');
    }
    if (reason) throw new Error(reason);
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

function todayMelbourne(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne' }).format(new Date());
}

function percent(rate: number | null | undefined): string {
  return `${Math.round((rate ?? 0) * 100)}%`;
}

function resetLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-AU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Australia/Melbourne',
  });
}

function onboardingLabel(iso: string | null): string {
  if (!iso) return 'not yet';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'not yet';
  return date.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
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
  billing_anchor: string;
  billing_period_end: string;
  texts_sent_this_month: number;
  clicks_this_month: number;
  click_rate_this_month: number;
  review_count: number | null;
  rating: number | null;
  starting_review_count: number | null;
  reviews_gained: number | null;
  last_snapshot_date: string | null;
  sender_number: string | null;
  sender_verified_at: string | null;
  sender_checked_at: string | null;
  tests_count: number;
  payment_taken_at: string | null;
  number_verified_at: string | null;
  onboarding_created_at: string | null;
  login_link_sent_at: string | null;
  test_text_sent_at: string | null;
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
    clicked_at: string | null;
    last_error: string | null;
    customers: { first_name: string; mobile: string } | { first_name: string; mobile: string }[] | null;
  }[];
  replies: {
    id: string;
    from_mobile: string;
    body: string;
    customers: { first_name: string } | { first_name: string }[] | null;
  }[];
};

const ACTIVITY_STATUS_LABEL: Record<string, string> = {
  queued: 'Queued',
  sending: 'Sending',
  sent: 'Sent',
  clicked: 'Link opened',
  failed: 'Failed',
  cancelled: 'Cancelled',
  opted_out: 'Opted out',
  skipped: 'Skipped',
};

function activityStatus(message: ActivityData['messages'][number]): string {
  if (message.clicked_at) return 'Link opened';
  return ACTIVITY_STATUS_LABEL[message.status] ?? message.status;
}

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

type OnboardingItem = {
  item: string;
  label: string;
  field: keyof Business;
};

const ONBOARDING_ITEMS: OnboardingItem[] = [
  { item: 'payment_taken', label: 'Payment taken', field: 'payment_taken_at' },
  { item: 'number_verified', label: 'Number verified', field: 'number_verified_at' },
  { item: 'business_created', label: 'Business created', field: 'onboarding_created_at' },
  { item: 'login_link_sent', label: 'Login link sent', field: 'login_link_sent_at' },
  { item: 'test_text_sent', label: 'Test text sent', field: 'test_text_sent_at' },
];

function OnboardingChecklist({
  business,
  onToggle,
}: {
  business: Business;
  onToggle: (item: string, label: string, done: boolean) => void;
}) {
  return (
    <ul className="list" style={{ gap: 2 }}>
      {ONBOARDING_ITEMS.map(({ item, label, field }) => {
        const iso = business[field] as string | null;
        return (
          <li key={item} style={{ padding: 0, border: 0 }}>
            <span className="row" style={{ gap: 6 }}>
              <span aria-hidden="true">{iso ? '✓' : '○'}</span>
              <span className="hint" style={{ margin: 0 }}>
                {label} · {onboardingLabel(iso)}
              </span>
              <button
                className="ghost"
                type="button"
                aria-pressed={Boolean(iso)}
                aria-label={`${label} for ${business.name}: ${iso ? 'done' : 'not yet'}`}
                onClick={() => onToggle(item, label, !iso)}
              >
                {iso ? 'Undo' : 'Tick'}
              </button>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export default function AdminScreen() {
  const [tab, setTab] = useState<'businesses' | 'demo' | 'audit'>('businesses');
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [placesUsage, setPlacesUsage] = useState<{ rows: { request_count: number }[]; cap: number } | null>(
    null,
  );
  const [viewAs, setViewAs] = useState<{ id: string; name: string; sendMode: string } | null>(null);
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
        review_count: String(fd.get('review_count') ?? '').trim() || null,
        sender_number: String(fd.get('sender_number') ?? '').trim() || null,
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

  async function onSetBillingAnchor(e: FormEvent) {
    e.preventDefault();
    const form = e.currentTarget as HTMLFormElement;
    const fd = new FormData(form);
    const id = String(fd.get('business_id') ?? '');
    const anchor = String(fd.get('billing_anchor') ?? '');
    setNotice(null);
    try {
      await adminFetch(`/admin/businesses/${id}/billing-anchor`, 'POST', {
        billing_anchor: anchor,
      });
      setNotice({ kind: 'ok', text: `Billing date set to day ${Number(anchor.slice(8, 10))} each month.` });
      refresh();
    } catch (err) {
      showError(err);
    }
  }

  async function onSetSender(e: FormEvent) {
    e.preventDefault();
    const form = e.currentTarget as HTMLFormElement;
    const fd = new FormData(form);
    const id = String(fd.get('business_id') ?? '');
    setNotice(null);
    try {
      await adminFetch(`/admin/businesses/${id}/sender-number`, 'POST', {
        sender_number: String(fd.get('sender_number') ?? '').trim(),
      });
      setNotice({ kind: 'ok', text: 'Sender mobile saved. Press Check again to verify it.' });
      refresh();
    } catch (err) {
      showError(err);
    }
  }

  async function onCheckSender(id: string, name: string) {
    setNotice(null);
    try {
      const r = await adminFetch(`/admin/businesses/${id}/check-sender`, 'POST', {});
      setNotice({
        kind: r?.verified ? 'ok' : 'error',
        text: r?.verified
          ? `Sender for ${name} is verified.`
          : `Sender for ${name} is not verified yet. Add it in Mobile Message under Sender IDs > Own Mobile Number, enter the code, then press Check again.`,
      });
      refresh();
    } catch (err) {
      showError(err);
    }
  }

  async function onToggleOnboarding(
    id: string,
    item: string,
    label: string,
    done: boolean,
  ) {
    setNotice(null);
    try {
      await adminFetch(`/admin/businesses/${id}/onboarding`, 'POST', { item, done });
      setNotice({
        kind: 'ok',
        text: `${label} marked as ${done ? 'done' : 'not done'}.`,
      });
      refresh();
    } catch (err) {
      showError(err);
    }
  }

  async function onSetReviewCount(e: FormEvent) {
    e.preventDefault();
    const form = e.currentTarget as HTMLFormElement;
    const fd = new FormData(form);
    const id = String(fd.get('business_id') ?? '');
    const count = Number(fd.get('review_count'));
    const ratingRaw = String(fd.get('rating') ?? '').trim();
    setNotice(null);
    try {
      await adminFetch(`/admin/businesses/${id}/review-count`, 'POST', {
        review_count: count,
        snapshot_date: String(fd.get('snapshot_date') ?? ''),
        rating: ratingRaw === '' ? null : Number(ratingRaw),
      });
      setNotice({ kind: 'ok', text: `Google review count set to ${count}.` });
      refresh();
    } catch (err) {
      showError(err);
    }
  }

  async function runTestSend(id: string, name: string) {
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

  async function onSendTestNow(e: FormEvent) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget as HTMLFormElement);
    const id = String(fd.get('business_id') ?? '');
    const name = businesses.find((b) => b.id === id)?.name ?? 'this business';
    await runTestSend(id, name);
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

  async function onViewAs(id: string, name: string, sendMode: string) {
    setViewAs({ id, name, sendMode });
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
                            {activityStatus(m)}
                            {m.message_text ? ` · ${m.message_text}` : ''}
                          </span>
                          {m.status === 'failed' && m.last_error && (
                            <span className="item-sub">{m.last_error}</span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
              <section className="screen-section">
                <h2>Replies</h2>
                {!repliesReachApp(viewAs.sendMode) ? (
                  <p className="empty">{OWN_PHONE_REPLY_NOTE}</p>
                ) : activity.replies.length === 0 ? (
                  <p className="empty">No replies yet.</p>
                ) : (
                  <ul className="list">
                    {activity.replies.map((r) => {
                      const customer = Array.isArray(r.customers) ? r.customers[0] : r.customers;
                      return (
                        <li key={r.id}>
                          <span className="item-title">{r.body}</span>
                          <span className="item-sub">
                            {customer?.first_name ?? 'Customer'} · {r.from_mobile}
                          </span>
                        </li>
                      );
                    })}
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
            {businesses.length > 0 && (
              <form onSubmit={onSendTestNow} className="card">
                <h2>Send test now</h2>
                <p className="muted" style={{ margin: 0 }}>
                  Sends one text immediately to the allowlisted number, ignoring quiet hours and the
                  delay. It is not counted in usage or stats.
                </p>
                <label className="field">
                  <span>Business</span>
                  <select name="business_id" defaultValue={businesses[0].id}>
                    {businesses.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button type="submit" className="btn btn-primary">
                  Send test now
                </button>
              </form>
            )}
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
                <span>Sender mobile (SMS provider only)</span>
                <input name="sender_number" type="tel" placeholder="04xx xxx xxx" />
              </label>
              <p className="field-note">
                Live sending stays off until this number is verified in Mobile Message.
              </p>
              <label className="field">
                <span>Review request delay (minutes)</span>
                <input name="delay" type="number" min={0} defaultValue={60} />
              </label>
              <label className="field">
                <span>Google review count today (optional)</span>
                <input
                  name="review_count"
                  type="number"
                  min={0}
                  placeholder="e.g. 42"
                />
              </label>
              <p className="field-note">
                This is the starting point for “reviews gained since joining”.
              </p>
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
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Status</th>
                      <th>Mode</th>
                      <th>Results</th>
                      <th>Google reviews</th>
                      <th>Allowance</th>
                      <th>Sender / Gateway</th>
                      <th>Tests</th>
                      <th>Onboarding</th>
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
                        <td>
                          <p className="hint">
                            This month: {b.texts_sent_this_month} texts · {b.clicks_this_month}{' '}
                            clicks · {percent(b.click_rate_this_month)}
                          </p>
                          <p className="hint">
                            All time: {b.texts_sent} texts · {b.clicks} clicks ·{' '}
                            {percent(b.texts_sent > 0 ? b.clicks / b.texts_sent : 0)}
                          </p>
                        </td>
                        <td>
                          <p className="hint">
                            {b.review_count === null
                              ? 'No count yet'
                              : `${b.review_count} reviews now${
                                  b.rating === null ? '' : ` · ${b.rating}★`
                                }`}
                          </p>
                          <p className="hint">Gained since joining: {b.reviews_gained ?? '—'}</p>
                          <form onSubmit={onSetReviewCount} className="stack" style={{ gap: 6 }}>
                            <input type="hidden" name="business_id" value={b.id} />
                            <span className="row">
                              <input
                                name="review_count"
                                type="number"
                                min={0}
                                step={1}
                                defaultValue={b.review_count ?? ''}
                                placeholder="Review count"
                                aria-label={`Google review count for ${b.name}`}
                                style={{ width: 110 }}
                                required
                              />
                              <input
                                name="rating"
                                type="number"
                                min={0}
                                max={5}
                                step={0.1}
                                defaultValue={b.rating ?? ''}
                                placeholder="Rating"
                                aria-label={`Google rating for ${b.name}`}
                                style={{ width: 80 }}
                              />
                            </span>
                            <span className="row">
                              <input
                                name="snapshot_date"
                                type="date"
                                defaultValue={todayMelbourne()}
                                aria-label={`Date of the review count for ${b.name}`}
                              />
                              <button className="ghost" type="submit">
                                Save count
                              </button>
                            </span>
                          </form>
                        </td>
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
                          <p className="hint" style={{ margin: '6px 0 0' }}>
                            Resets {resetLabel(b.billing_period_end)}
                          </p>
                          <form onSubmit={onSetBillingAnchor} className="row">
                            <input type="hidden" name="business_id" value={b.id} />
                            <input
                              name="billing_anchor"
                              type="date"
                              defaultValue={b.billing_anchor}
                              aria-label={`Billing date for ${b.name}`}
                            />
                            <button className="ghost" type="submit">
                              Save date
                            </button>
                          </form>
                        </td>
                        <td>
                          {b.send_mode === 'sms_provider' ? (
                            <>
                              <p className="hint" style={{ margin: 0 }}>
                                {b.sender_number ?? 'No sender mobile set'}
                              </p>
                              <p className="hint" style={{ margin: 0 }}>
                                {b.sender_verified_at
                                  ? `verified ${onboardingLabel(b.sender_verified_at)}`
                                  : b.sender_checked_at
                                    ? `not verified · checked ${onboardingLabel(b.sender_checked_at)}`
                                    : 'not checked yet'}
                              </p>
                              {!b.sender_verified_at && (
                                <p className="hint" style={{ margin: 0 }}>
                                  Not verified yet: add it in Mobile Message under Sender IDs &gt; Own
                                  Mobile Number, enter the code, then press Check again
                                </p>
                              )}
                              <form onSubmit={onSetSender} className="row">
                                <input type="hidden" name="business_id" value={b.id} />
                                <input
                                  name="sender_number"
                                  type="tel"
                                  defaultValue={b.sender_number ?? ''}
                                  placeholder="04xx xxx xxx"
                                  aria-label={`Sender mobile for ${b.name}`}
                                  style={{ width: 115 }}
                                />
                                <button className="ghost" type="submit">
                                  Save
                                </button>
                              </form>
                              <button
                                className="ghost"
                                type="button"
                                onClick={() => onCheckSender(b.id, b.name)}
                              >
                                Check again
                              </button>
                            </>
                          ) : (
                            <span>{b.gateway_online ? 'online' : 'offline'}</span>
                          )}
                        </td>
                        <td>
                          <span className="hint" style={{ margin: 0 }}>
                            {b.tests_count} test {b.tests_count === 1 ? 'text' : 'texts'}
                          </span>
                        </td>
                        <td>
                          <OnboardingChecklist
                            business={b}
                            onToggle={(item, label, done) =>
                              onToggleOnboarding(b.id, item, label, done)
                            }
                          />
                        </td>
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
                            <button
                              className="ghost"
                              type="button"
                              onClick={() => onViewAs(b.id, b.name, b.send_mode)}
                            >
                              View
                            </button>
                            <button
                              className="ghost"
                              type="button"
                              onClick={() => runTestSend(b.id, b.name)}
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
