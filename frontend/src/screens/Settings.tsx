import { useEffect, useState } from 'react';
import { supabase } from '../supabase';

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
  skipped_opted_out: number;
  skipped_recent: number;
  skipped_duplicate: number;
};

export default function Settings() {
  const [business, setBusiness] = useState<{ id: string; logo_url: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [interest, setInterest] = useState<'loading' | 'no' | 'yes'>('loading');

  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<string[][]>([]);
  const [nameCol, setNameCol] = useState(-1);
  const [mobileCol, setMobileCol] = useState(-1);
  const [summary, setSummary] = useState<Summary | null>(null);

  useEffect(() => {
    supabase
      .from('businesses')
      .select('id,logo_url')
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

  async function onUpload(file: File) {
    if (!business) return;
    setBusy(true);
    setMsg('');
    const path = `${business.id}/logo`;
    const { error } = await supabase.storage
      .from('logos')
      .upload(path, file, { upsert: true, contentType: file.type });
    if (error) {
      setMsg(error.message);
      setBusy(false);
      return;
    }
    const { data } = supabase.storage.from('logos').getPublicUrl(path);
    const { error: updErr } = await supabase
      .from('businesses')
      .update({ logo_url: data.publicUrl })
      .eq('id', business.id);
    if (updErr) {
      setMsg(updErr.message);
      setBusy(false);
      return;
    }
    setBusiness({ ...business, logo_url: data.publicUrl });
    setMsg('Logo updated.');
    setBusy(false);
  }

  async function onRemove() {
    if (!business) return;
    setBusy(true);
    setMsg('');
    await supabase.storage.from('logos').remove([`${business.id}/logo`]);
    await supabase.from('businesses').update({ logo_url: null }).eq('id', business.id);
    setBusiness({ ...business, logo_url: null });
    setMsg('Logo removed.');
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
    setMsg('');
    const { data, error } = await supabase.rpc('import_customers', {
      p_business_id: business.id,
      p_rows: mappedRows(),
      p_commit: commit,
    });
    setBusy(false);
    if (error) {
      setMsg(error.message);
      return;
    }
    setSummary(data?.[0] ?? null);
  }

  async function onInterest() {
    if (!business) return;
    setBusy(true);
    setMsg('');
    const { error } = await supabase
      .from('ai_reply_interest')
      .upsert({ business_id: business.id }, { onConflict: 'business_id', ignoreDuplicates: true });
    setBusy(false);
    if (error) {
      setMsg(error.message);
      return;
    }
    setInterest('yes');
  }

  return (
    <div className="page">
      <header className="screen-head">
        <h1>Settings</h1>
        <p className="muted">Your logo, customer imports, and extras.</p>
      </header>

      <section className="card">
        <h2>Business logo</h2>
        <p className="muted" style={{ margin: 0 }}>
          Shown in your header and on review pages.
        </p>
        {business?.logo_url && (
          <img
            src={business.logo_url}
            alt="Your business logo"
            style={{ width: 72, height: 72, borderRadius: '50%', objectFit: 'cover' }}
          />
        )}
        <label className="field">
          <span>Logo image (PNG, JPG or WebP)</span>
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            disabled={busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
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
              Skipped — invalid {summary.skipped_invalid} · opted out {summary.skipped_opted_out} ·
              asked recently {summary.skipped_recent} · duplicate {summary.skipped_duplicate}
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

      {msg && <p className="warn">{msg}</p>}
    </div>
  );
}
