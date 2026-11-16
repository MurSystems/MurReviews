import { useState } from 'react';
import { supabase } from './supabase';
import { config } from './config';
import AddCustomer from './screens/AddCustomer';
import Activity from './screens/Activity';
import Dashboard from './screens/Dashboard';
import Settings from './screens/Settings';

const SCREENS = [
  { key: 'add', label: 'Add', Component: AddCustomer },
  { key: 'activity', label: 'Activity', Component: Activity },
  { key: 'dashboard', label: 'Dashboard', Component: Dashboard },
  { key: 'settings', label: 'Settings', Component: Settings },
] as const;

export default function Shell() {
  const [screen, setScreen] = useState<string>('add');
  const current = SCREENS.find((s) => s.key === screen) ?? SCREENS[0];

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
        {SCREENS.map((s) => (
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
