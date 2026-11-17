import { useEffect, useState } from 'react';
import { supabase } from '../supabase';
import { friendlyError } from '../errors';

type Usage = {
  used: number;
  allowance: number;
  reset_at: string;
  state: 'ok' | 'warning' | 'paused';
};

function resetLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'the 1st';
  return date.toLocaleDateString('en-AU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Australia/Melbourne',
  });
}

export default function MonthlyUsage({ businessId }: { businessId: string }) {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    supabase
      .rpc('owner_text_usage', { p_business_id: businessId })
      .then(({ data, error: err }) => {
        if (!alive) return;
        if (err) {
          setError(friendlyError(err.message));
          return;
        }
        setUsage((data?.[0] as Usage | undefined) ?? null);
      });
    return () => {
      alive = false;
    };
  }, [businessId]);

  const pct = usage
    ? usage.allowance > 0
      ? Math.min(100, Math.round((usage.used / usage.allowance) * 100))
      : 100
    : 0;

  return (
    <section className="card screen-section">
      <h2>Texts this month</h2>
      {error && <p className="error">{error}</p>}
      {!usage && !error && <p className="muted">Loading…</p>}
      {usage && (
        <>
          <p className="usage-line">
            <strong>
              {usage.used} of {usage.allowance} texts used this month
            </strong>
          </p>
          <div
            className="usage-bar"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={usage.allowance}
            aria-valuenow={usage.used}
            aria-label="Monthly texts used"
          >
            <span className={`usage-fill ${usage.state}`} style={{ width: `${pct}%` }} />
          </div>
          <p className="muted">Resets on {resetLabel(usage.reset_at)} (Melbourne time).</p>

          {usage.state === 'warning' && (
            <p className="usage-banner warn" role="status">
              You&apos;ve used {pct}% of this month&apos;s texts. Sending will pause when the
              allowance runs out.
            </p>
          )}
          {usage.state === 'paused' && (
            <p className="usage-banner error" role="alert">
              Texts are paused until {resetLabel(usage.reset_at)}. Contact Mur Systems to increase
              your limit. Anything already queued will send after the reset unless it&apos;s more
              than 7 days old, in which case it will be cancelled.
            </p>
          )}
        </>
      )}
    </section>
  );
}
