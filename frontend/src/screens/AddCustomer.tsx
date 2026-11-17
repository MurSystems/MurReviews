import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { supabase } from '../supabase';

const OUTCOME: Record<string, string> = {
  opted_out: 'That number replied STOP before, so we won’t text it.',
  recent: 'That number had a review request in the last 90 days, so we skipped it.',
  capped: 'This business has reached its trial text limit. Ask Mur Systems to upgrade it.',
  invalid_mobile: 'That doesn’t look like an Australian mobile. Enter a number starting with 04.',
  invalid_name: 'Enter the customer’s first name.',
};

type Business = {
  id: string;
  name: string;
  timezone: string;
  delay_minutes: number;
};

type Success = {
  name: string;
  when: string;
};

function formatSendTime(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'shortly';
  try {
    const day = new Intl.DateTimeFormat('en-AU', {
      timeZone,
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    }).format(date);
    const time = new Intl.DateTimeFormat('en-AU', {
      timeZone,
      hour: 'numeric',
      minute: '2-digit',
    }).format(date);
    return `${day} at ${time}`;
  } catch {
    return 'shortly';
  }
}

export default function AddCustomer() {
  const [business, setBusiness] = useState<Business | null>(null);
  const [loadingBusiness, setLoadingBusiness] = useState(true);
  const [firstName, setFirstName] = useState('');
  const [mobile, setMobile] = useState('');
  const [success, setSuccess] = useState<Success | null>(null);
  const [outcome, setOutcome] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await supabase
          .from('businesses')
          .select('id,name,timezone,delay_minutes')
          .limit(1)
          .single();
        if (!cancelled) setBusiness(data ?? null);
      } catch {
        if (!cancelled) setBusiness(null);
      } finally {
        if (!cancelled) setLoadingBusiness(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!business) return;
    const name = firstName.trim();
    setBusy(true);
    setError('');
    setOutcome('');
    setSuccess(null);

    const { data, error } = await supabase.rpc('add_customer', {
      p_business_id: business.id,
      p_first_name: name,
      p_mobile: mobile.trim(),
    });

    if (error) {
      setBusy(false);
      setError(
        /not authorized|42501/i.test(error.message)
          ? 'This account isn’t linked to a business yet. Ask Mur Systems to set it up.'
          : 'We couldn’t save that customer. Check the details and try again.',
      );
      return;
    }

    const row = data?.[0];
    const result = (row?.outcome as string) ?? 'queued';
    if (result !== 'queued') {
      setBusy(false);
      setOutcome(OUTCOME[result] ?? 'That customer wasn’t queued. Check the details and try again.');
      return;
    }

    let when = 'shortly';
    if (row?.message_id) {
      const { data: message } = await supabase
        .from('messages')
        .select('scheduled_at')
        .eq('id', row.message_id)
        .single();
      if (message?.scheduled_at) {
        when = formatSendTime(message.scheduled_at, business.timezone);
      }
    }

    setBusy(false);
    setSuccess({ name, when });
    setFirstName('');
    setMobile('');
  }

  if (loadingBusiness) {
    return <div className="page page-narrow muted">Loading…</div>;
  }

  if (!business) {
    return (
      <div className="page page-narrow">
        <h1>New customer</h1>
        <p className="warn">
          No business is linked to this account yet. Ask Mur Systems to set one up.
        </p>
      </div>
    );
  }

  return (
    <form className="page page-narrow stack" onSubmit={onSubmit}>
      <div>
        <h1>New customer</h1>
        <p className="muted">We’ll text them a Google review link after the job.</p>
      </div>

      {success && (
        <div className="notice notice-inline" role="status">
          <p>
            Review request for <strong>{success.name}</strong> queued for {success.when}.
          </p>
        </div>
      )}

      {outcome && (
        <p className="warn" role="alert">
          {outcome}
        </p>
      )}

      <label className="field">
        <span>Customer’s first name</span>
        <input
          autoComplete="off"
          value={firstName}
          onChange={(e) => setFirstName(e.target.value)}
          required
        />
      </label>

      <label className="field">
        <span>Mobile number</span>
        <input
          type="tel"
          inputMode="numeric"
          autoComplete="tel"
          placeholder="0412 345 678"
          value={mobile}
          onChange={(e) => setMobile(e.target.value)}
          required
        />
      </label>
      <p className="hint">Australian mobile starting with 04.</p>

      <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
        {busy ? 'Saving…' : 'Send review request'}
      </button>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
