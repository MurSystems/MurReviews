import { useEffect, useState } from 'react';
import { supabase } from '../supabase';
import { config } from '../config';

type Stats = {
  reviews_gained: number;
  rating: number | null;
  review_count: number | null;
  texts_sent: number;
  clicks: number;
  click_rate: number;
};

type Snapshot = {
  snapshot_date: string;
  rating: number | null;
  review_count: number | null;
};

function formatDay(iso: string): string {
  const date = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function Dashboard() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [placesConnected, setPlacesConnected] = useState<boolean | null>(null);

  useEffect(() => {
    fetch(`${config.workerUrl}/status`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setPlacesConnected(data?.places_connected === true))
      .catch(() => setPlacesConnected(false));

    supabase
      .from('businesses')
      .select('id')
      .limit(1)
      .single()
      .then(({ data }) => {
        const id = data?.id;
        if (!id) return;
        supabase
          .rpc('owner_dashboard', { p_business_id: id })
          .then(({ data }) => setStats(data?.[0] ?? null));
        supabase
          .from('review_snapshots')
          .select('snapshot_date,rating,review_count')
          .eq('business_id', id)
          .order('snapshot_date', { ascending: true })
          .then(({ data }) => setSnapshots(data ?? []));
      });
  }, []);

  const clickRate = stats ? Math.round((stats.click_rate ?? 0) * 100) : 0;

  return (
    <div className="page">
      <header className="screen-head">
        <h1>Dashboard</h1>
        <p className="muted">How your review requests are going.</p>
      </header>

      {!stats && <p className="muted">Loading…</p>}

      {stats && (
        <>
          <div className="stats">
            <div className="stat">
              <p className="stat-label">Texts sent</p>
              <p className="stat-value">{stats.texts_sent}</p>
            </div>
            <div className="stat">
              <p className="stat-label">Clicks</p>
              <p className="stat-value">{stats.clicks}</p>
            </div>
            <div className="stat">
              <p className="stat-label">Click rate</p>
              <p className="stat-value">{clickRate}%</p>
            </div>
          </div>

          <section className="card screen-section" style={{ marginTop: 0 }}>
            <h2>Reviews gained since you joined</h2>
            {placesConnected === true ? (
              <>
                <p className="stat-value" style={{ margin: 0 }}>
                  {stats.reviews_gained}
                </p>
                <p className="muted" style={{ margin: 0 }}>
                  Current rating {stats.rating ?? '—'} · {stats.review_count ?? 0} total reviews
                </p>
              </>
            ) : (
              <p className="muted" style={{ margin: 0 }}>
                {placesConnected === null
                  ? 'Checking Google review tracking…'
                  : 'Google review tracking not connected yet.'}
              </p>
            )}
          </section>

          {placesConnected === true && (
            <section className="screen-section">
              <h2>Reviews over time</h2>
              {snapshots.length === 0 ? (
                <p className="empty">No snapshots yet. We take one each day.</p>
              ) : (
                <ul className="list">
                  {snapshots.map((s) => (
                    <li key={s.snapshot_date}>
                      <span className="item-title">{formatDay(s.snapshot_date)}</span>
                      <span className="item-sub">
                        {s.rating ?? '—'}★ · {s.review_count ?? 0} reviews
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}
