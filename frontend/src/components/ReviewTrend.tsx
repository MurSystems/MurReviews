import { useState } from 'react';
import type { PointerEvent } from 'react';

export type TrendPoint = {
  snapshot_date: string;
  rating: number | null;
  review_count: number | null;
};

const W = 360;
const H = 180;
const LEFT = 38;
const RIGHT = 16;
const TOP = 16;
const BOTTOM = 26;

function dayLabel(iso: string): string {
  const date = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
}

function dayLabelLong(iso: string): string {
  const date = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
}

function niceStep(raw: number): number {
  if (raw <= 0) return 1;
  const power = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / power;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return step * power;
}

export default function ReviewTrend({ snapshots }: { snapshots: TrendPoint[] }) {
  const [hover, setHover] = useState<number | null>(null);

  const points = snapshots
    .filter((s) => s.review_count !== null)
    .map((s) => ({ ...s, review_count: s.review_count as number }));

  if (points.length < 2) {
    if (points.length === 0) {
      return <p className="empty">No review counts yet.</p>;
    }
    return (
      <p className="empty">
        One snapshot so far — {points[0].review_count} reviews on{' '}
        {dayLabelLong(points[0].snapshot_date)}. The chart appears once there are two.
      </p>
    );
  }

  const times = points.map((p) => new Date(`${p.snapshot_date}T00:00:00`).getTime());
  const minT = Math.min(...times);
  const maxT = Math.max(...times);
  const span = maxT - minT || 1;
  const counts = points.map((p) => p.review_count);
  const minC = Math.min(...counts);
  const maxC = Math.max(...counts);
  const step = niceStep((maxC - minC) / 3 || 1);
  const yMin = Math.floor(minC / step) * step;
  const yMaxRaw = Math.ceil(maxC / step) * step;
  const yMax = yMaxRaw === yMin ? yMin + step : yMaxRaw;

  const plotW = W - LEFT - RIGHT;
  const plotH = H - TOP - BOTTOM;

  const xAt = (t: number) => LEFT + ((t - minT) / span) * plotW;
  const yAt = (c: number) => TOP + plotH - ((c - yMin) / (yMax - yMin)) * plotH;

  const xs = times.map(xAt);
  const ys = counts.map(yAt);

  const line = xs
    .map((x, i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${ys[i].toFixed(1)}`)
    .join(' ');
  const area = `${line} L${xs[xs.length - 1].toFixed(1)},${(TOP + plotH).toFixed(1)} L${xs[0].toFixed(
    1,
  )},${(TOP + plotH).toFixed(1)} Z`;

  const ticks: number[] = [];
  for (let v = yMin; v <= yMax + step / 2; v += step) ticks.push(v);

  function onMove(e: PointerEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    let nearest = 0;
    for (let i = 1; i < xs.length; i++) {
      if (Math.abs(xs[i] - px) < Math.abs(xs[nearest] - px)) nearest = i;
    }
    setHover(nearest);
  }

  const last = points.length - 1;

  return (
    <div className="chart">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Review count from ${dayLabelLong(points[0].snapshot_date)} to ${dayLabelLong(
          points[last].snapshot_date,
        )}, ${points[0].review_count} to ${points[last].review_count} reviews.`}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={LEFT}
              x2={W - RIGHT}
              y1={yAt(t)}
              y2={yAt(t)}
              stroke="var(--line)"
              strokeWidth={1}
            />
            <text
              x={LEFT - 6}
              y={yAt(t) + 3}
              textAnchor="end"
              fontSize={10}
              fill="var(--text-muted)"
              style={{ fontVariantNumeric: 'tabular-nums' }}
            >
              {t}
            </text>
          </g>
        ))}

        <path d={area} fill="var(--accent)" opacity={0.08} />
        <path
          d={line}
          fill="none"
          stroke="var(--accent)"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {xs.map((x, i) => (
          <circle
            key={points[i].snapshot_date}
            cx={x}
            cy={ys[i]}
            r={hover === i ? 5 : 4}
            fill="var(--accent)"
            stroke="var(--bg)"
            strokeWidth={2}
          />
        ))}

        {hover !== null && (
          <line
            x1={xs[hover]}
            x2={xs[hover]}
            y1={TOP}
            y2={TOP + plotH}
            stroke="var(--text-muted)"
            strokeWidth={1}
          />
        )}

        <text
          x={Math.min(xs[last] - 6, W - RIGHT)}
          y={Math.max(ys[last] - 10, TOP + 8)}
          textAnchor="end"
          fontSize={11}
          fontWeight={600}
          fill="var(--text)"
        >
          {points[last].review_count}
        </text>

        <text x={LEFT} y={H - 8} fontSize={10} fill="var(--text-muted)">
          {dayLabel(points[0].snapshot_date)}
        </text>
        <text x={W - RIGHT} y={H - 8} textAnchor="end" fontSize={10} fill="var(--text-muted)">
          {dayLabel(points[last].snapshot_date)}
        </text>
      </svg>

      {hover !== null && (
        <div
          className="chart-tip"
          style={{ left: `clamp(62px, ${(xs[hover] / W) * 100}%, calc(100% - 62px))` }}
        >
          <strong>{points[hover].review_count} reviews</strong>
          <span>{dayLabelLong(points[hover].snapshot_date)}</span>
        </div>
      )}

      <details className="chart-table">
        <summary>View as table</summary>
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Rating</th>
              <th>Reviews</th>
            </tr>
          </thead>
          <tbody>
            {points.map((p) => (
              <tr key={p.snapshot_date}>
                <td>{dayLabelLong(p.snapshot_date)}</td>
                <td>{p.rating === null ? '—' : p.rating}</td>
                <td>{p.review_count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
