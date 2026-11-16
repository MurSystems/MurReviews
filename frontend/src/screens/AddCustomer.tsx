import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { supabase } from '../supabase';

const OUTCOME: Record<string, string> = {
  queued: 'Review request queued ✓',
  opted_out: 'This number has opted out — not contacted.',
  recent: 'Already asked in the last 90 days — skipped.',
  capped: 'Trial text limit reached.',
  invalid_mobile: 'Enter a valid Australian mobile (04…).',
  invalid_name: 'Enter a name.',
};

export default function AddCustomer() {
  const [businessId, setBusinessId] = useState<string | null>(null);
  const [firstName, setFirstName] = useState('');
  const [mobile, setMobile] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    supabase
      .from('businesses')
      .select('id')
      .limit(1)
      .single()
      .then(({ data }) => setBusinessId(data?.id ?? null));
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!businessId) {
      setError('No business found for this account.');
      return;
    }
    setBusy(true);
    setError('');
    setResult(null);
    const { data, error } = await supabase.rpc('add_customer', {
      p_business_id: businessId,
      p_first_name: firstName.trim(),
      p_mobile: mobile.trim(),
    });
    setBusy(false);
    if (error) {
      setError(error.message);
      return;
    }
    const outcome = (data?.[0]?.outcome as string) ?? 'queued';
    setResult(outcome);
    if (outcome === 'queued') {
      setFirstName('');
      setMobile('');
    }
  }

  return (
    <form className="card" onSubmit={onSubmit}>
      <h1>New customer</h1>
      <p className="muted">We'll text them a Google review link after the job.</p>
      <input
        placeholder="First name"
        value={firstName}
        onChange={(e) => setFirstName(e.target.value)}
        required
      />
      <input
        type="tel"
        inputMode="tel"
        placeholder="Mobile (e.g. 0412 345 678)"
        value={mobile}
        onChange={(e) => setMobile(e.target.value)}
        required
      />
      <button type="submit" disabled={busy}>
        {busy ? 'Sending…' : 'Send review request'}
      </button>
      {result && (
        <p className={result === 'queued' ? 'ok' : 'warn'}>
          {OUTCOME[result] ?? result}
        </p>
      )}
      {error && <p className="error">{error}</p>}
    </form>
  );
}
