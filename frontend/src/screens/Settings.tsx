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

export default function Settings() {
  const [business, setBusiness] = useState<{ id: string; logo_url: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<string[][]>([]);
  const [nameCol, setNameCol] = useState(-1);
  const [mobileCol, setMobileCol] = useState(-1);
  const [summary, setSummary] = useState<any>(null);

  useEffect(() => {
    supabase
      .from('businesses')
      .select('id,logo_url')
      .limit(1)
      .single()
      .then(({ data }) => setBusiness(data ?? null));
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

  return (
    <div className="card">
      <h1>Settings</h1>

      <h2>Logo</h2>
      {business?.logo_url && (
        <img
          src={business.logo_url}
          alt="logo"
          style={{ width: 64, height: 64, borderRadius: '50%', objectFit: 'cover' }}
        />
      )}
      <input
        type="file"
        accept="image/png,image/jpeg,image/webp"
        disabled={busy}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onUpload(f);
        }}
      />
      {business?.logo_url && (
        <button className="ghost" onClick={onRemove} disabled={busy}>
          Remove logo
        </button>
      )}

      <h2>Import customers</h2>
      <input
        type="file"
        accept=".csv,text/csv"
        disabled={busy}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onCsv(f);
        }}
      />
      {headers.length > 0 && (
        <>
          <p className="muted">Map your columns:</p>
          <select value={nameCol} onChange={(e) => setNameCol(Number(e.target.value))}>
            <option value={-1}>Name column…</option>
            {headers.map((h, i) => (
              <option key={i} value={i}>{h || `Column ${i + 1}`}</option>
            ))}
          </select>
          <select value={mobileCol} onChange={(e) => setMobileCol(Number(e.target.value))}>
            <option value={-1}>Mobile column…</option>
            {headers.map((h, i) => (
              <option key={i} value={i}>{h || `Column ${i + 1}`}</option>
            ))}
          </select>
          <button
            type="button"
            disabled={busy || nameCol < 0 || mobileCol < 0}
            onClick={() => runImport(false)}
          >
            Preview
          </button>
        </>
      )}

      {summary && (
        <div>
          <p>
            Will send: <strong>{summary.will_send}</strong> · Invalid: {summary.skipped_invalid} ·
            Opted out: {summary.skipped_opted_out} · Recent: {summary.skipped_recent} ·
            Duplicate: {summary.skipped_duplicate}
          </p>
          <button type="button" disabled={busy || !summary.will_send} onClick={() => runImport(true)}>
            Confirm import
          </button>
        </div>
      )}

      {msg && <p className="warn">{msg}</p>}
    </div>
  );
}
