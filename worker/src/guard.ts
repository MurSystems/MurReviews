// Pure, testable logic for the sender (no Cloudflare runtime imports).

export function isAllowed(
  mode: string,
  mobile: string,
  production: string,
  allowlist: string[],
): boolean {
  return production === "true" || mode === "log_only" || allowlist.includes(mobile);
}

// Admin test sends must always go to an allowlisted number, even when the
// Worker is in production (PRODUCTION=true disables isAllowed's bypass).
export function isAllowlisted(mobile: string, allowlist: string[]): boolean {
  return allowlist.includes(mobile);
}

// HTTP Basic credentials are UTF-8 bytes base64-encoded (RFC 7617). btoa only
// accepts Latin1, so encode the string first or a credential with any other
// character throws InvalidCharacterError before the request is made.
export function basicAuth(user: string, password: string): string {
  const bytes = new TextEncoder().encode(`${user}:${password}`);
  let latin1 = "";
  for (const byte of bytes) latin1 += String.fromCharCode(byte);
  return `Basic ${btoa(latin1)}`;
}

// Turn a sender error into a short, plain-language reason an admin can act on.
export function sendFailureReason(error: unknown): string {
  const msg = String(error);
  const provider = msg.match(
    /(Mobile Message|SMSGate) send failed \((\d{3})\)(?::\s*([\s\S]*))?/,
  );
  if (provider) {
    const [, name, status, detail = ""] = provider;
    if (status === "401" || status === "403") {
      return `${name} rejected the login. Check the ${name} username and password secrets.`;
    }
    if (status === "429") {
      return `${name} is limiting how fast this account can send. Try again shortly.`;
    }
    const trimmed = detail.trim().slice(0, 200);
    return `${name} rejected the text${trimmed ? `: ${trimmed}` : ` (${status}).`}`;
  }
  if (/no connected phone/.test(msg)) {
    return "That business has no phone connected for sending.";
  }
  if (/not implemented/.test(msg)) {
    return "That business's send mode cannot send texts yet.";
  }
  if (/fetch failed|network|connection.*lost|timed out|ENOTFOUND|ECONNRESET/i.test(msg)) {
    return "The text provider could not be reached. Check the connection and try again.";
  }
  return "The test text could not be sent. The Worker logs have the exact error.";
}

// Turn an unexpected admin-route error into a plain reason instead of leaving
// the browser to show a generic "having trouble" message.
export function adminFailureReason(error: unknown): string {
  const msg = String(error);
  const db = msg.match(/Supabase (?:RPC|GET) \S* failed: (\d{3})/);
  if (db) {
    const status = db[1];
    if (status === "401" || status === "403") {
      return "The admin server's database key was rejected. Check the SUPABASE_SERVICE_ROLE_KEY secret.";
    }
    if (status === "404") {
      return "The admin database is missing a function. Run the latest database migrations.";
    }
    if (status === "429" || status.startsWith("5")) {
      return "The database is busy. Try again in a moment.";
    }
    return "The database rejected the admin request.";
  }
  if (/fetch failed|network|connection.*lost|timed out|ENOTFOUND|ECONNRESET/i.test(msg)) {
    return "The admin server could not reach the database. Try again.";
  }
  return "The admin server could not complete that request. The Worker logs have the exact error.";
}

// A send that never reaches a real handset: log_only always, and every mode
// while the live switch is off. These must be recorded with messages.mock=true
// so they never count as real sends in stats.
export function isMockSend(mode: string, senderLive: string | undefined): boolean {
  return mode === "log_only" || senderLive !== "true";
}

// Verify an SMSGate webhook HMAC-SHA256 signature. The signature is computed
// over `rawBody + timestamp` (unix seconds) and sent hex-encoded, with a
// constant-time comparison so nobody can fake replies or opt-outs.
export async function verifyHmacSignature(
  rawBody: string,
  timestamp: string,
  signature: string,
  secret: string,
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(rawBody + timestamp),
  );
  const hex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  if (hex.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) {
    diff |= hex.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return diff === 0;
}

// Verify a caller's Supabase JWT. Returns the user id, or null if invalid.
export async function verifyUserJwt(
  jwt: string,
  url: string,
  anonKey: string,
): Promise<string | null> {
  if (!jwt) return null;
  const userRes = await fetch(`${url}/auth/v1/user`, {
    headers: { apikey: anonKey, Authorization: `Bearer ${jwt}` },
  });
  if (!userRes.ok) return null;
  const user = (await userRes.json()) as { id?: string };
  return user.id ?? null;
}

// Verify a caller's Supabase JWT and that their profile has the admin role.
// Returns the user id, or null if the JWT is invalid or the user is not admin.
export async function verifyAdminJwt(
  jwt: string,
  url: string,
  anonKey: string,
  serviceKey: string,
): Promise<string | null> {
  const userId = await verifyUserJwt(jwt, url, anonKey);
  if (!userId) return null;

  const profRes = await fetch(
    `${url}/rest/v1/profiles?id=eq.${userId}&role=eq.admin&select=id`,
    {
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    },
  );
  if (!profRes.ok) return null;
  const profs = (await profRes.json()) as unknown[];
  return profs.length > 0 ? userId : null;
}

// SMSGate posts {event, deviceId, payload:{sender,message,...}}. Older/self-
// hosted builds put sender/text at the top level, so read both.
export interface WebhookEventInfo {
  type: string;
  deviceId: string;
  fromMobile: string;
  body: string;
}

export function parseWebhookEvent(
  event: Record<string, unknown> | null | undefined,
): WebhookEventInfo {
  const payload = (event?.payload ?? {}) as Record<string, unknown>;
  const pick = (...values: unknown[]): string => {
    for (const v of values) {
      if (typeof v === "string" && v !== "") return v;
    }
    return "";
  };
  return {
    type: pick(event?.event, event?.type),
    deviceId: pick(event?.deviceId),
    fromMobile: pick(payload.sender, event?.sender, payload.phoneNumber),
    body: pick(payload.message, event?.text, event?.body),
  };
}

// Same rule as public.normalise_au_mobile in the database.
export function normaliseAuMobile(
  mobile: string | null | undefined,
): string | null {
  if (!mobile) return null;
  let digits = mobile.replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 11 && digits.startsWith("61")) {
    digits = "0" + digits.slice(2);
  } else if (digits.length === 9 && digits.startsWith("4")) {
    digits = "0" + digits;
  } else if (!(digits.length === 10 && digits.startsWith("04"))) {
    return null;
  }
  return /^04[0-9]{8}$/.test(digits) ? "+61" + digits.slice(1) : null;
}

// CORS: allow only origins listed in CORS_ORIGINS (echo back the request's
// Origin when it is allowed; otherwise no allow header, so the browser blocks).
export function allowedOrigin(request: Request, corsOrigins: string): string {
  const origin = request.headers.get("origin");
  const allowed = corsOrigins
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return origin && allowed.includes(origin) ? origin : "";
}

export function corsHeaders(allowOrigin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export function withCors(res: Response, allowOrigin: string): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(corsHeaders(allowOrigin))) {
    headers.set(k, v);
  }
  return new Response(res.body, { status: res.status, headers });
}

// Call Supabase's admin generate_link with the given type. "invite" sends a
// set-your-password link for a new owner; "recovery" sends a reset link.
export async function generateAuthLink(
  url: string,
  serviceKey: string,
  email: string,
  type: "invite" | "recovery",
): Promise<{ userId: string; link: string }> {
  const res = await fetch(`${url}/auth/v1/admin/generate_link`, {
    method: "POST",
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ type, email }),
  });
  if (!res.ok) throw new Error(`generate_link (${type}) failed: ${res.status}`);
  const data = (await res.json()) as { id?: string; action_link?: string };
  return { userId: data.id ?? "", link: data.action_link ?? "" };
}
