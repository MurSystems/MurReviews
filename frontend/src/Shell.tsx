import { useEffect, useState } from 'react';
import { supabase } from './supabase';
import { config } from './config';
import { LogoMark } from './components/Logo';
import ThemeToggle from './components/ThemeToggle';
import { initials } from './initials';
import AddCustomer from './screens/AddCustomer';
import Activity from './screens/Activity';
import Dashboard from './screens/Dashboard';
import Settings from './screens/Settings';
import AdminScreen from './admin/AdminScreen';
import InstallPrompt from './components/InstallPrompt';
import { installKind, isStandalone } from './install';

const BASE_SCREENS = [
  { key: 'add', label: 'Add', Component: AddCustomer },
  { key: 'activity', label: 'Activity', Component: Activity },
  { key: 'dashboard', label: 'Dashboard', Component: Dashboard },
  { key: 'settings', label: 'Settings', Component: Settings },
] as const;

export default function Shell() {
  const [screen, setScreen] = useState<string>('add');
  const [isAdmin, setIsAdmin] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);
  const [showWhatsNew, setShowWhatsNew] = useState(false);
  const [showInstall, setShowInstall] = useState(false);
  const [business, setBusiness] = useState<{
    id: string;
    name: string;
    logo_url: string | null;
  } | null>(null);

  function loadBusiness() {
    supabase
      .from('businesses')
      .select('id,name,logo_url')
      .limit(1)
      .single()
      .then(({ data }) => setBusiness(data ?? null));
  }

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      const id = data.user?.id;
      if (!id) return;
      setUserId(id);
      try {
        setShowWhatsNew(localStorage.getItem(`mur-whats-new:${id}`) !== config.whatsNew.version);
      } catch {
        setShowWhatsNew(true);
      }
      // Install is offered once on a phone, and always in Settings.
      if (installKind() !== 'none' && !isStandalone()) {
        try {
          setShowInstall(localStorage.getItem(`mur-install-seen:${id}`) !== '1');
        } catch {
          setShowInstall(true);
        }
      }
      supabase
        .from('profiles')
        .select('role')
        .eq('id', id)
        .single()
        .then(({ data: p }) => setIsAdmin(p?.role === 'admin'));
    });
    loadBusiness();
    const onLogoChanged = () => loadBusiness();
    window.addEventListener('mur-logo-changed', onLogoChanged);
    return () => window.removeEventListener('mur-logo-changed', onLogoChanged);
  }, []);

  function dismissWhatsNew() {
    if (userId) {
      try {
        localStorage.setItem(`mur-whats-new:${userId}`, config.whatsNew.version);
      } catch {
        // Storage unavailable — the notice can show again next visit.
      }
    }
    setShowWhatsNew(false);
  }

  function dismissInstall() {
    if (userId) {
      try {
        localStorage.setItem(`mur-install-seen:${userId}`, '1');
      } catch {
        // Storage unavailable — the prompt can show again next visit.
      }
    }
    setShowInstall(false);
  }

  const screens = isAdmin
    ? [...BASE_SCREENS, { key: 'admin', label: 'Admin', Component: AdminScreen }]
    : BASE_SCREENS;
  const current = screens.find((s) => s.key === screen) ?? screens[0];

  return (
    <div className="shell">
      <header className="app-header">
        <div className="app-brand">
          <LogoMark size={34} />
          <strong className="business-name">{business?.name ?? config.product}</strong>
          {business &&
            (business.logo_url ? (
              <img className="badge" src={business.logo_url} alt="" />
            ) : (
              <span className="badge">{initials(business.name)}</span>
            ))}
        </div>
        <ThemeToggle />
        <button className="btn-ghost" onClick={() => supabase.auth.signOut()}>
          Log out
        </button>
      </header>

      {showInstall && !isStandalone() && (
        <div className="install-once">
          <InstallPrompt dismissible onDismiss={dismissInstall} />
        </div>
      )}

      {showWhatsNew && (
        <div className="whats-new" role="status">
          <p>{config.whatsNew.message}</p>
          <button className="btn-ghost" onClick={dismissWhatsNew}>
            Got it
          </button>
        </div>
      )}

      <main className="content">
        <current.Component />
      </main>

      <nav className="tabbar" aria-label="Sections">
        {screens.map((s) => (
          <button
            key={s.key}
            className={s.key === current.key ? 'tab active' : 'tab'}
            aria-current={s.key === current.key ? 'page' : undefined}
            onClick={() => setScreen(s.key)}
          >
            {s.label}
          </button>
        ))}
      </nav>
    </div>
  );
}
