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
