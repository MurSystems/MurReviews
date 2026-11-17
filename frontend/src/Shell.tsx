import { useEffect, useState } from 'react';
import { supabase } from './supabase';
import { config } from './config';
import AddCustomer from './screens/AddCustomer';
import Activity from './screens/Activity';
import Dashboard from './screens/Dashboard';
import Settings from './screens/Settings';
import AdminScreen from './admin/AdminScreen';

const BASE_SCREENS = [
  { key: 'add', label: 'Add', Component: AddCustomer },
  { key: 'activity', label: 'Activity', Component: Activity },
  { key: 'dashboard', label: 'Dashboard', Component: Dashboard },
  { key: 'settings', label: 'Settings', Component: Settings },
] as const;

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

export default function Shell() {
  const [screen, setScreen] = useState<string>('add');
  const [isAdmin, setIsAdmin] = useState(false);
  const [business, setBusiness] = useState<{
    id: string;
    name: string;
    logo_url: string | null;
  } | null>(null);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      const userId = data.user?.id;
      if (!userId) return;
      supabase
        .from('profiles')
        .select('role')
        .eq('id', userId)
        .single()
        .then(({ data: p }) => setIsAdmin(p?.role === 'admin'));
    });
    supabase
      .from('businesses')
      .select('id,name,logo_url')
      .limit(1)
      .single()
      .then(({ data }) => setBusiness(data ?? null));
  }, []);

  const screens = isAdmin
    ? [...BASE_SCREENS, { key: 'admin', label: 'Admin', Component: AdminScreen }]
    : BASE_SCREENS;
  const current = screens.find((s) => s.key === screen) ?? screens[0];

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          {business?.logo_url ? (
            <img className="badge" src={business.logo_url} alt="" />
          ) : (
            <span className="badge">{business ? initials(business.name) : '?'}</span>
          )}
          <strong>{business?.name ?? config.product}</strong>
        </div>
        <button className="ghost" onClick={() => supabase.auth.signOut()}>
          Log out
        </button>
      </header>
      <main className="content">
        <current.Component />
      </main>
      <nav className="tabbar">
        {screens.map((s) => (
          <button
            key={s.key}
            className={s.key === screen ? 'tab active' : 'tab'}
            onClick={() => setScreen(s.key)}
          >
            {s.label}
          </button>
        ))}
      </nav>
    </div>
  );
}
