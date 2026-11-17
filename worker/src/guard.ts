// Pure, testable logic for the sender (no Cloudflare runtime imports).

export function isAllowed(
  mode: string,
  mobile: string,
  production: string,
  allowlist: string[],
): boolean {
  return production === "true" || mode === "log_only" || allowlist.includes(mobile);
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

// Verify a caller's Supabase JWT and that their profile has the admin role.
// Returns the user id, or null if the JWT is invalid or the user is not admin.
export async function verifyAdminJwt(
  jwt: string,
  url: string,
  anonKey: string,
  serviceKey: string,
): Promise<string | null> {
  if (!jwt) return null;

  const userRes = await fetch(`${url}/auth/v1/user`, {
    headers: { apikey: anonKey, Authorization: `Bearer ${jwt}` },
  });
  if (!userRes.ok) return null;
  const user = (await userRes.json()) as { id: string };

  const profRes = await fetch(
    `${url}/rest/v1/profiles?id=eq.${user.id}&role=eq.admin&select=id`,
    {
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    },
  );
  if (!profRes.ok) return null;
  const profs = (await profRes.json()) as unknown[];
  return profs.length > 0 ? user.id : null;
}
