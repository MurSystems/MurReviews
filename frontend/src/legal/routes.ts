export type LegalKind = 'terms' | 'privacy';

// Public legal pages are plain paths handled before auth.
export function legalPageFromPath(pathname: string): LegalKind | null {
  const path = pathname.replace(/\/+$/, '').toLowerCase();
  if (path === '/terms') return 'terms';
  if (path === '/privacy') return 'privacy';
  return null;
}
