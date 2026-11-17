import { useEffect, useState } from 'react';
import { supabase } from '../supabase';

type Message = {
  id: string;
  status: string;
  mock: boolean | null;
  sent_at: string | null;
  created_at: string;
  customers: { first_name: string } | { first_name: string }[] | null;
};

type Reply = {
  id: string;
  from_mobile: string;
  body: string;
  received_at: string;
};

const STATUS_LABEL: Record<string, string> = {
  queued: 'Queued',
  sending: 'Sending',
  sent: 'Sent',
  clicked: 'Link opened',
  failed: 'Failed',
  skipped: 'Skipped',
};

function firstNameOf(message: Message): string {
  const customer = Array.isArray(message.customers) ? message.customers[0] : message.customers;
  return customer?.first_name || 'Customer';
}

function formatWhen(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('en-AU', {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export default function Activity() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [replies, setReplies] = useState<Reply[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: business, error: businessError } = await supabase
        .from('businesses')
        .select('id')
        .limit(1)
        .single();
      if (!business?.id || businessError) {
        if (!cancelled) {
          setError('No business is linked to this account yet.');
          setLoading(false);
        }
        return;
      }
      const [messagesResult, repliesResult] = await Promise.all([
        supabase
          .from('messages')
          .select('id,status,mock,sent_at,created_at,customers(first_name)')
          .eq('business_id', business.id)
          .order('created_at', { ascending: false })
          .limit(20),
        supabase
          .from('replies')
          .select('id,from_mobile,body,received_at')
          .eq('business_id', business.id)
          .order('received_at', { ascending: false })
          .limit(20),
      ]);
      if (cancelled) return;
      if (messagesResult.error || repliesResult.error) {
        setError('We couldn’t load your activity. Try again in a moment.');
      } else {
        setMessages((messagesResult.data as Message[]) ?? []);
        setReplies((repliesResult.data as Reply[]) ?? []);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="page">
      <header className="screen-head">
        <h1>Activity</h1>
        <p className="muted">Your latest texts and the replies that came back.</p>
      </header>

      {loading && <p className="muted">Loading…</p>}
      {error && <p className="warn">{error}</p>}

      {!loading && !error && (
        <>
          <section className="card">
            <h2>Texts</h2>
            {messages.length === 0 ? (
              <p className="empty">No texts yet. Add a customer to send the first one.</p>
            ) : (
              <ul className="list">
                {messages.map((m) => (
                  <li key={m.id}>
                    <span className="item-title">
                      {firstNameOf(m)}
                      {m.mock ? ' (test)' : ''}
                    </span>
                    <span className="item-sub">
                      {STATUS_LABEL[m.status] ?? m.status}
                      {formatWhen(m.sent_at ?? m.created_at)
                        ? ` · ${formatWhen(m.sent_at ?? m.created_at)}`
                        : ''}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="screen-section">
            <h2>Replies</h2>
            {replies.length === 0 ? (
              <p className="empty">No replies yet. They’ll appear here when customers text back.</p>
            ) : (
              <ul className="list">
                {replies.map((r) => (
                  <li key={r.id}>
                    <span className="item-title">{r.body}</span>
                    <span className="item-sub">
                      {r.from_mobile}
                      {formatWhen(r.received_at) ? ` · ${formatWhen(r.received_at)}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
