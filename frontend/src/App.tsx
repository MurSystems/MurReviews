import { useCallback, useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';
import Login from './auth/Login';
import SetPassword from './auth/SetPassword';
import Shell from './Shell';
import { isSetPasswordPath, takeAuthLinkError } from './authLink';

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  // Recovery links land on /set-password; the event also catches older links
  // that redirect to the root.
  const [recovery, setRecovery] = useState(isSetPasswordPath);
  const [linkError] = useState(takeAuthLinkError);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s);
      if (event === 'PASSWORD_RECOVERY') setRecovery(true);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const finishRecovery = useCallback(() => {
    if (isSetPasswordPath()) {
      window.history.replaceState(window.history.state, '', '/');
    }
    setRecovery(false);
  }, []);

  if (loading) return <div className="center muted">Loading…</div>;
  if (recovery) {
    return <SetPassword hasSession={!!session} linkError={linkError} onDone={finishRecovery} />;
  }
  return session ? <Shell /> : <Login linkError={linkError} />;
}
