import { useState } from 'react';
import { useInstall } from '../install';

const STEPS = (
  <ol className="install-steps">
    <li>Tap the Share button (the square with an arrow).</li>
    <li>Scroll down and tap “Add to Home Screen”.</li>
    <li>Tap “Add”. Mur Reviews then opens full screen.</li>
  </ol>
);

function Body({ compact }: { compact: boolean }) {
  const { canPrompt, install, kind } = useInstall();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  if (done) {
    return (
      <p className="ok" role="status" style={{ margin: 0 }}>
        Installed. Open Mur Reviews from your home screen.
      </p>
    );
  }

  if (kind === 'ios-safari') {
    return (
      <>
        <p className="muted" style={{ margin: 0 }}>
          On iPhone, add Mur Reviews to your home screen from Safari:
        </p>
        {STEPS}
      </>
    );
  }

  if (kind === 'ios-other') {
    return (
      <>
        <p style={{ margin: 0 }}>Open this link in Safari to install it.</p>
        <p className="hint" style={{ margin: 0 }}>
          Copy the address below, paste it into Safari, then tap Share → Add to Home Screen.
        </p>
        <code className="link-text">{window.location.origin}</code>
      </>
    );
  }

  if (kind === 'android') {
    if (!canPrompt) {
      return (
        <p className="muted" style={{ margin: 0 }}>
          In Chrome, open the ⋮ menu and choose “Install app” (or “Add to Home screen”).
        </p>
      );
    }
    return (
      <>
        {!compact && (
          <p className="muted" style={{ margin: 0 }}>
            Add it to your home screen so it opens full screen, like an app.
          </p>
        )}
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            const accepted = await install();
            setBusy(false);
            if (accepted) setDone(true);
          }}
        >
          {busy ? 'Installing…' : 'Install Mur Reviews'}
        </button>
      </>
    );
  }

  return (
    <p className="muted" style={{ margin: 0 }}>
      Open Mur Reviews in Chrome on Android, or Safari on iPhone, to install it.
    </p>
  );
}

// Shown once after the first login on a phone, and always on Settings.
export default function InstallPrompt({
  dismissible = false,
  onDismiss,
}: {
  dismissible?: boolean;
  onDismiss?: () => void;
}) {
  const { installed } = useInstall();
  if (installed) return null;

  return (
    <section className="card install-card">
      <h2>{dismissible ? 'Install Mur Reviews' : 'Install the app'}</h2>
      <Body compact={dismissible} />
      {dismissible && onDismiss && (
        <button type="button" className="btn-ghost" onClick={onDismiss}>
          Not now
        </button>
      )}
    </section>
  );
}
