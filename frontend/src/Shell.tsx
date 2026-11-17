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

export default function Shell() {
  const [screen, setScreen] = useState<string>('add');
  const [isAdmin, setIsAdmin] = useState(false);

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
  }, []);

  const screens = isAdmin
    ? [...BASE_SCREENS, { key: 'admin', label: 'Admin', Component: AdminScreen }]
    : BASE_SCREENS;
  const current = screens.find((s) => s.key === screen) ?? screens[0];

  return (
    <div className="shell">
      <header className="topbar">
        <strong>{config.product}</strong>
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
