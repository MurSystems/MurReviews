import { useEffect, useState } from 'react';
import { supabase } from '../supabase';

export default function Settings() {
  const [business, setBusiness] = useState<{
    id: string;
    logo_url: string | null;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

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
    await supabase
      .from('businesses')
      .update({ logo_url: null })
      .eq('id', business.id);
    setBusiness({ ...business, logo_url: null });
    setMsg('Logo removed.');
    setBusy(false);
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
      {msg && <p className="warn">{msg}</p>}
    </div>
  );
}
