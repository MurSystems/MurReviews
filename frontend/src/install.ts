import { useCallback, useEffect, useState } from 'react';

// Chrome/Edge fire this instead of exposing install() on navigator.
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const nav = window.navigator as Navigator & { standalone?: boolean };
  return (
    window.matchMedia?.('(display-mode: standalone)').matches === true ||
    window.matchMedia?.('(display-mode: fullscreen)').matches === true ||
    nav.standalone === true
  );
}

function isIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  // iPadOS reports a desktop Macintosh user agent, so touch points are the tell.
  return (
    /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1)
  );
}

export type InstallKind = 'android' | 'ios-safari' | 'ios-other' | 'none';

export function installKind(): InstallKind {
  if (typeof navigator === 'undefined') return 'none';
  if (isIos()) {
    // Chrome, Firefox, Edge and Opera on iOS cannot add to the home screen.
    return /CriOS|FxiOS|EdgiOS|OPiOS/i.test(navigator.userAgent) ? 'ios-other' : 'ios-safari';
  }
  if (/Android/i.test(navigator.userAgent)) return 'android';
  return 'none';
}

export function useInstall() {
  const [promptEvent, setPromptEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(isStandalone);

  useEffect(() => {
    function onPrompt(e: Event) {
      // Keep Chrome's mini-infobar from appearing; the Install button uses it.
      e.preventDefault();
      setPromptEvent(e as BeforeInstallPromptEvent);
    }
    function onInstalled() {
      setInstalled(true);
      setPromptEvent(null);
    }
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const install = useCallback(async (): Promise<boolean> => {
    if (!promptEvent) return false;
    await promptEvent.prompt();
    const choice = await promptEvent.userChoice;
    setPromptEvent(null);
    if (choice.outcome === 'accepted') setInstalled(true);
    return choice.outcome === 'accepted';
  }, [promptEvent]);

  return { canPrompt: promptEvent !== null, installed, install, kind: installKind() };
}
