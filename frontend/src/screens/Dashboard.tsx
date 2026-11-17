import { useEffect, useState } from 'react';
import { supabase } from '../supabase';
import { config } from '../config';

export default function Dashboard() {
  const [stats, setStats] = useState<any>(null);
  const [snapshots, setSnapshots] = useState<any[]>([]);
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
    <div>
      <h1>Dashboard</h1>
      {stats ? (
        <>
          <div className="card" style={{ maxWidth: 'none' }}>
            <h2>Reviews gained since you joined</h2>
            {placesConnected === true ? (
              <>
                <p style={{ fontSize: 40, fontWeight: 700, margin: '4px 0' }}>
                  {stats.reviews_gained}
                </p>
                <p className="muted">
                  Current rating {stats.rating ?? '—'} · {stats.review_count ?? 0} total reviews
                </p>
              </>
            ) : (
              <p className="muted">
                {placesConnected === null
                  ? 'Checking Google review tracking…'
                  : 'Google review tracking not connected yet.'}
              </p>
            )}
          </div>
          <div className="card" style={{ maxWidth: 'none' }}>
            <p>Texts sent: <strong>{stats.texts_sent}</strong></p>
            <p>Clicks: <strong>{stats.clicks}</strong></p>
            <p>Click rate: <strong>{clickRate}%</strong></p>
          </div>
          {placesConnected === true && (
            <>
              <h2>Reviews over time</h2>
              {snapshots.length === 0 && <p className="muted">No snapshots yet.</p>}
              <ul>
                {snapshots.map((s) => (
                  <li key={s.snapshot_date}>
                    {s.snapshot_date}: {s.rating ?? '—'}★ · {s.review_count ?? 0} reviews
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      ) : (
        <p className="muted">Loading…</p>
      )}
    </div>
  );
}
