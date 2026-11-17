import { useEffect, useState } from 'react';
import { supabase } from '../supabase';
import { config } from '../config';
import MonthlyUsage from '../components/MonthlyUsage';
import ReviewTrend from '../components/ReviewTrend';

type Stats = {
  month_start: string;
  month_end: string;
  texts_sent_this_month: number;
  clicks_this_month: number;
  click_rate_this_month: number;
  texts_sent: number;
  clicks: number;
  click_rate: number;
  review_count: number | null;
  rating: number | null;
  starting_review_count: number | null;
  reviews_gained: number | null;
  last_snapshot_date: string | null;
};

type Snapshot = {
  snapshot_date: string;
  rating: number | null;
  review_count: number | null;
};

function formatDay(iso: string): string {
  const date = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
}

function percent(rate: number | null | undefined): string {
  return `${Math.round((rate ?? 0) * 100)}%`;
}

function ratingLabel(rating: number | null): string {
  if (rating === null) return '—';
  return `${Number(rating).toFixed(1)}★`;
}

function gainedLabel(gained: number | null): string {
  if (gained === null) return '—';
  return gained > 0 ? `+${gained}` : String(gained);
}

function StatsRow({ stats, period }: { stats: Stats; period: 'month' | 'all' }) {
  const sent = period === 'month' ? stats.texts_sent_this_month : stats.texts_sent;
  const clicks = period === 'month' ? stats.clicks_this_month : stats.clicks;
  const rate = period === 'month' ? stats.click_rate_this_month : stats.click_rate;
  return (
    <div className="stats">
      <div className="stat">
        <p className="stat-label">Texts sent</p>
        <p className="stat-value">{sent}</p>
      </div>
      <div className="stat">
        <p className="stat-label">Link clicks</p>
        <p className="stat-value">{clicks}</p>
      </div>
      <div className="stat">
        <p className="stat-label">Click rate</p>
        <p className="stat-value">{percent(rate)}</p>
      </div>
    </div>
  );
}

export default function Dashboard() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [businessId, setBusinessId] = useState<string | null>(null);
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
        setBusinessId(id);
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

  const hasReviews = stats !== null && stats.review_count !== null;

  return (
    <div className="page">
      <header className="screen-head">
        <h1>Dashboard</h1>
        <p className="muted">How your review requests are going.</p>
      </header>

      {businessId && <MonthlyUsage businessId={businessId} />}

      {!stats && <p className="muted">Loading…</p>}

      {stats && (
        <>
          <section className="screen-section">
            <h2>This month</h2>
            <p className="muted" style={{ marginTop: 0 }}>
              {formatDay(stats.month_start)} – {formatDay(stats.month_end)} (your billing period).
              Test texts never count.
            </p>
            <StatsRow stats={stats} period="month" />
          </section>

          <section className="screen-section">
            <h2>All time</h2>
            <StatsRow stats={stats} period="all" />
          </section>

          <section className="card screen-section">
            <h2>Google reviews</h2>
            {hasReviews ? (
              <>
                <div className="stats" style={{ margin: 0 }}>
                  <div className="stat">
                    <p className="stat-label">Rating now</p>
                    <p className="stat-value">{ratingLabel(stats.rating)}</p>
                  </div>
                  <div className="stat">
                    <p className="stat-label">Reviews now</p>
                    <p className="stat-value">{stats.review_count}</p>
                  </div>
                  <div className="stat">
                    <p className="stat-label">Gained since joining</p>
                    <p className="stat-value">{gainedLabel(stats.reviews_gained)}</p>
                  </div>
                </div>
                {stats.starting_review_count !== null && (
                  <p className="muted" style={{ margin: 0 }}>
                    Started at {stats.starting_review_count} reviews.
                  </p>
                )}
              </>
            ) : (
              <p className="muted" style={{ margin: 0 }}>
                No Google review count yet.
              </p>
            )}
            <p className="hint" style={{ margin: 0 }}>
              {placesConnected === true
                ? 'Google counts update automatically each day.'
                : placesConnected === null
                  ? 'Checking Google review tracking…'
                  : 'Mur Systems adds the count until Google tracking is connected.'}
            </p>
          </section>

          <section className="screen-section">
            <h2>Review count over time</h2>
            <ReviewTrend snapshots={snapshots} />
          </section>
        </>
      )}
    </div>
  );
}
