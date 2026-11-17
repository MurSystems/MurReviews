import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { supabase } from '../supabase';
import { friendlyError } from '../errors';
import { saveTheme } from '../theme';
import { useTheme } from '../useTheme';
import { initials } from '../initials';

const MAX_LOGO_BYTES = 1024 * 1024;
const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

function parseCsv(text: string): string[][] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const out: string[] = [];
      let cur = '';
      let q = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') {
          if (q && line[i + 1] === '"') {
            cur += '"';
            i++;
          } else {
            q = !q;
          }
        } else if (c === ',' && !q) {
          out.push(cur);
          cur = '';
        } else {
          cur += c;
        }
      }
      out.push(cur);
      return out;
    });
}

type Summary = {
  will_send: number;
  skipped_invalid: number;
  skipped_missing_name: number;
  skipped_opted_out: number;
  skipped_recent: number;
  skipped_duplicate: number;
};

export default function Settings() {
  const [business, setBusiness] = useState<{
    id: string;
    name: string;
    logo_url: string | null;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [interest, setInterest] = useState<'loading' | 'no' | 'yes'>('loading');
  const theme = useTheme();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [pwBusy, setPwBusy] = useState(false);

  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<string[][]>([]);
  const [nameCol, setNameCol] = useState(-1);
  const [mobileCol, setMobileCol] = useState(-1);
  const [summary, setSummary] = useState<Summary | null>(null);

  useEffect(() => {
    supabase
      .from('businesses')
      .select('id,name,logo_url')
      .limit(1)
      .single()
      .then(({ data }) => {
        setBusiness(data ?? null);
        if (!data?.id) {
          setInterest('no');
          return;
        }
        supabase
          .from('ai_reply_interest')
          .select('business_id')
          .eq('business_id', data.id)
          .maybeSingle()
          .then(({ data: row }) => setInterest(row ? 'yes' : 'no'));
      });
  }, []);

  function show(kind: 'ok' | 'error', text: string) {
    setNotice({ kind, text });
  }

  async function onUpload(file: File) {
    if (!business) return;
    if (!LOGO_TYPES.includes(file.type)) {
      show('error', 'Choose a PNG, JPG or WebP image.');
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      show('error', 'That image is too large. The limit is 1 MB.');
      return;
    }
    setBusy(true);
    setNotice(null);
    const path = `${business.id}/logo`;
    const { error } = await supabase.storage
      .from('logos')
      .upload(path, file, { upsert: true, contentType: file.type });
    if (error) {
      show('error', friendlyError(error.message));
      setBusy(false);
      return;
    }
    const { data } = supabase.storage.from('logos').getPublicUrl(path);
    // A versioned URL means a replaced logo shows immediately, even if the
    // browser cached the previous image at the same path.
    const url = `${data.publicUrl}?v=${Date.now()}`;
    const { error: updErr } = await supabase
      .from('businesses')
      .update({ logo_url: url })
      .eq('id', business.id);
    if (updErr) {
      show('error', friendlyError(updErr.message));
      setBusy(false);
      return;
    }
    setBusiness({ ...business, logo_url: url });
    window.dispatchEvent(new Event('mur-logo-changed'));
    show('ok', 'Logo updated.');
    setBusy(false);
  }

  async function onRemove() {
    if (!business) return;
    setBusy(true);
    setNotice(null);
    const { error: rmErr } = await supabase.storage.from('logos').remove([`${business.id}/logo`]);
    if (rmErr) {
      show('error', friendlyError(rmErr.message));
      setBusy(false);
      return;
    }
    const { error: updErr } = await supabase
      .from('businesses')
      .update({ logo_url: null })
      .eq('id', business.id);
    if (updErr) {
      show('error', friendlyError(updErr.message));
      setBusy(false);
      return;
    }
    setBusiness({ ...business, logo_url: null });
    window.dispatchEvent(new Event('mur-logo-changed'));
    show('ok', 'Logo removed.');
    setBusy(false);
  }

  function onCsv(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      const parsed = parseCsv(String(reader.result));
      if (parsed.length === 0) return;
      setHeaders(parsed[0]);
      setRows(parsed.slice(1));
      setNameCol(-1);
      setMobileCol(-1);
      setSummary(null);
    };
    reader.readAsText(file);
  }

  function mappedRows() {
    return rows.map((r) => ({ name: r[nameCol] ?? '', mobile: r[mobileCol] ?? '' }));
  }

  async function runImport(commit: boolean) {
    if (!business) return;
    setBusy(true);
    setNotice(null);
    const { data, error } = await supabase.rpc('import_customers', {
      p_business_id: business.id,
      p_rows: mappedRows(),
      p_commit: commit,
    });
    setBusy(false);
    if (error) {
      show('error', friendlyError(error.message));
      return;
    }
    setSummary(data?.[0] ?? null);
  }

  async function onInterest() {
    if (!business) return;
    setBusy(true);
    setNotice(null);
    const { error } = await supabase
      .from('ai_reply_interest')
      .upsert({ business_id: business.id }, { onConflict: 'business_id', ignoreDuplicates: true });
    setBusy(false);
    if (error) {
      show('error', friendlyError(error.message));
      return;
    }
    setInterest('yes');
  }

  async function onChangePassword(e: FormEvent) {
    e.preventDefault();
    setNotice(null);

    if (!password) {
      show('error', 'Enter a new password.');
      return;
    }
    if (password.length < 8) {
      show('error', 'Use at least 8 characters.');
      return;
    }
    if (password !== confirm) {
      show('error', 'The passwords don’t match.');
      return;
    }

    setPwBusy(true);
    const { error } = await supabase.auth.updateUser({ password });
    setPwBusy(false);
    if (error) {
      show('error', friendlyError(error.message));
      return;
    }
    setPassword('');
    setConfirm('');
    show('ok', 'Password updated. Use it next time you log in.');
  }

  return (
    <div className="page">
      <header className="screen-head">
        <h1>Settings</h1>
        <p className="muted">Your password, appearance, logo and customer imports.</p>
      </header>

      {notice && (
        <p
          className={notice.kind === 'ok' ? 'ok' : 'error'}
          role={notice.kind === 'ok' ? 'status' : 'alert'}
        >
          {notice.text}
        </p>
      )}

      <section className="card">
        <h2>Password</h2>
        <p className="muted" style={{ margin: 0 }}>
          Set a password so you can log in without an emailed link.
        </p>
        <form onSubmit={onChangePassword} className="stack">
          <label className="field">
            <span>New password</span>
            <input
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={8}
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
            />
          </label>
          <button type="submit" className="btn btn-primary" disabled={pwBusy}>
            {pwBusy ? 'Saving…' : 'Set or change password'}
          </button>
        </form>
      </section>

      <section className="card screen-section">
        <h2>Appearance</h2>
        <p className="muted" style={{ margin: 0 }}>
          Saved on this device. Until you choose, it follows your device.
        </p>
        <div className="row" role="group" aria-label="Theme">
          <button
            type="button"
            className={theme === 'light' ? 'btn btn-primary' : 'btn btn-secondary'}
            aria-pressed={theme === 'light'}
            onClick={() => saveTheme('light')}
          >
            Light
          </button>
          <button
            type="button"
            className={theme === 'dark' ? 'btn btn-primary' : 'btn btn-secondary'}
            aria-pressed={theme === 'dark'}
            onClick={() => saveTheme('dark')}
          >
            Dark
          </button>
        </div>
      </section>

      <section className="card screen-section">
        <h2>Business logo</h2>
        <p className="muted" style={{ margin: 0 }}>
          Shown in your header and on review pages.
        </p>
        {business &&
          (business.logo_url ? (
            <img
              src={business.logo_url}
              alt="Your business logo"
              style={{ width: 72, height: 72, borderRadius: '50%', objectFit: 'cover' }}
            />
          ) : (
            <span className="badge" style={{ width: 72, height: 72, fontSize: 24 }}>
              {initials(business.name)}
            </span>
          ))}
        <label className="field">
          <span>Logo image (PNG, JPG or WebP, max 1 MB)</span>
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            disabled={busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) onUpload(f);
            }}
          />
        </label>
        {business?.logo_url && (
          <button className="btn-ghost" onClick={onRemove} disabled={busy} type="button">
            Remove logo
          </button>
        )}
      </section>

      <section className="card screen-section">
        <h2>Import customers</h2>
        <p className="muted" style={{ margin: 0 }}>
          Upload a CSV and we’ll text up to 15 people a day, starting with the newest job.
        </p>
        <label className="field">
          <span>CSV file</span>
          <input
            type="file"
            accept=".csv,text/csv"
            disabled={busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onCsv(f);
            }}
          />
        </label>

        {headers.length > 0 && (
          <>
            <p className="hint">Map your columns</p>
            <label className="field">
              <span>Name column</span>
              <select value={nameCol} onChange={(e) => setNameCol(Number(e.target.value))}>
                <option value={-1}>Choose a column…</option>
                {headers.map((h, i) => (
                  <option key={i} value={i}>
                    {h || `Column ${i + 1}`}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Mobile column</span>
              <select value={mobileCol} onChange={(e) => setMobileCol(Number(e.target.value))}>
                <option value={-1}>Choose a column…</option>
                {headers.map((h, i) => (
                  <option key={i} value={i}>
                    {h || `Column ${i + 1}`}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || nameCol < 0 || mobileCol < 0}
              onClick={() => runImport(false)}
            >
              Preview import
            </button>
          </>
        )}

        {summary && (
          <div className="card" style={{ padding: 14 }}>
            <p style={{ margin: 0 }}>
              Will send: <strong>{summary.will_send}</strong>
            </p>
            <p className="hint" style={{ margin: 0 }}>
              Skipped — invalid number {summary.skipped_invalid} · missing name{' '}
              {summary.skipped_missing_name} · opted out {summary.skipped_opted_out} · asked
              recently {summary.skipped_recent} · duplicate {summary.skipped_duplicate}
            </p>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy || !summary.will_send}
              onClick={() => runImport(true)}
            >
              Confirm import
            </button>
          </div>
        )}
      </section>

      <section className="card screen-section">
        <h2>AI review replies</h2>
        <span className="pill">Coming soon</span>
        <p className="muted" style={{ margin: 0 }}>
          We’re building AI replies to your Google reviews, written in your business’s voice.
          Register your interest and we’ll set it up with you.
        </p>
        {interest === 'yes' ? (
          <p className="ok" style={{ margin: 0 }} role="status">
            You’re on the list — we’ll be in touch.
          </p>
        ) : (
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || interest === 'loading'}
            onClick={onInterest}
          >
            I want this
          </button>
        )}
      </section>
    </div>
  );
}
