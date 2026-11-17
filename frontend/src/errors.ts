// Turn auth, storage, database and Worker messages into plain sentences.
// Nothing technical from Supabase, Postgres or the Worker reaches the screen.

const RULES: [RegExp, string][] = [
  [
    /one of email or phone must be set|missing email or phone|email address is required/i,
    'Enter your email first.',
  ],
  [
    /invalid login credentials/i,
    'That email and password don’t match. Check them and try again.',
  ],
  [/email not confirmed/i, 'Confirm your email first — open the link we sent you.'],
  [
    /user not found|signups not allowed|no account|invalid claim/i,
    'We don’t recognise that email. Ask Mur Systems for an invite.',
  ],
  [
    /unable to validate email|invalid email|email address .* invalid/i,
    'Enter a valid email address.',
  ],
  [
    /rate limit|too many|for security purposes/i,
    'Too many attempts. Wait a minute and try again.',
  ],
  [
    /new password should be different/i,
    'Choose a password you haven’t used here before.',
  ],
  [
    /jwt expired|refresh token|auth session missing|session.*(expired|not found)/i,
    'Your session has ended. Log in again.',
  ],
  [
    /invalid grant|token has expired|link.*expired|otp.*expired/i,
    'That sign-in link has expired. Ask for a new one.',
  ],
  [
    /row-level security|permission denied|unauthori[sz]ed|forbidden/i,
    'You don’t have permission to do that.',
  ],
  [/duplicate key|already exists/i, 'That already exists.'],
  [
    /payload too large|maximum allowed size|file size|too large/i,
    'That image is too large. The limit is 1 MB.',
  ],
  [
    /mime|unsupported.*(type|file)|invalid file/i,
    'Choose a PNG, JPG or WebP image.',
  ],
  [
    /failed to fetch|networkerror|load failed|network request failed|fetch failed/i,
    'Can’t reach the server. Check your connection and try again.',
  ],
];

export function friendlyError(message: string | null | undefined): string {
  const text = (message ?? '').trim();
  if (!text) return 'Something went wrong. Try again.';

  const minLength = text.match(/password should be at least (\d+)/i);
  if (minLength) return `Use at least ${minLength[1]} characters.`;

  for (const [pattern, sentence] of RULES) {
    if (pattern.test(text)) return sentence;
  }
  return 'Something went wrong. Try again.';
}

export function friendly(error: unknown): string {
  if (error instanceof Error) return friendlyError(error.message);
  if (typeof error === 'string') return friendlyError(error);
  return 'Something went wrong. Try again.';
}
