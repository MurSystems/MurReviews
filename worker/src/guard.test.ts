import { describe, it, expect, vi, afterEach } from "vitest";
import { isAllowed, verifyHmacSignature, verifyAdminJwt } from "./guard";

describe("isAllowed", () => {
  it("allows log_only always", () => {
    expect(isAllowed("log_only", "+61499999999", "", [])).toBe(true);
  });
  it("allows production (exact 'true') always", () => {
    expect(isAllowed("demo", "+61499999999", "true", [])).toBe(true);
  });
  it("allows an allowlisted number", () => {
    expect(isAllowed("demo", "+61411875278", "", ["+61411875278"])).toBe(true);
  });
  it("rejects an unlisted number in non-production", () => {
    expect(isAllowed("demo", "+61499999999", "", [])).toBe(false);
  });
  it("treats non-'true' production as non-production", () => {
    expect(isAllowed("demo", "+61499999999", "TRUE", [])).toBe(false);
  });
});

describe("verifyHmacSignature", () => {
  const secret = "test-secret";
  async function sign(body: string, timestamp: string): Promise<string> {
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
      new TextEncoder().encode(body + timestamp),
    );
    return Array.from(new Uint8Array(sig))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  it("accepts a valid signature", async () => {
    const body = '{"event":"sms:received"}';
    const ts = "1700000000";
    const sig = await sign(body, ts);
    expect(await verifyHmacSignature(body, ts, sig, secret)).toBe(true);
  });

  it("rejects a wrong signature", async () => {
    expect(await verifyHmacSignature("body", "123", "deadbeef", secret)).toBe(
      false,
    );
  });

  it("rejects a signature for a different body", async () => {
    const ts = "1700000000";
    const sig = await sign("body A", ts);
    expect(await verifyHmacSignature("body B", ts, sig, secret)).toBe(false);
  });

  it("rejects a signature for a different timestamp", async () => {
    const body = "body";
    const sig = await sign(body, "1700000000");
    expect(await verifyHmacSignature(body, "1700000001", sig, secret)).toBe(
      false,
    );
  });
});

describe("verifyAdminJwt", () => {
  const url = "https://x.supabase.co";
  const anon = "anon-key";
  const svc = "service-key";

  afterEach(() => vi.restoreAllMocks());

  function mockFetch(profileIsAdmin: boolean) {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const u = String(input);
      if (u.endsWith("/auth/v1/user")) {
        return new Response(JSON.stringify({ id: "user-1" }), { status: 200 });
      }
      if (u.includes("/rest/v1/profiles")) {
        return new Response(
          JSON.stringify(profileIsAdmin ? [{ id: "user-1" }] : []),
          { status: 200 },
        );
      }
      return new Response("", { status: 404 });
    }) as typeof fetch;
  }

  it("accepts an admin JWT", async () => {
    mockFetch(true);
    expect(await verifyAdminJwt("jwt", url, anon, svc)).toBe("user-1");
  });

  it("rejects an owner (non-admin) JWT", async () => {
    mockFetch(false);
    expect(await verifyAdminJwt("jwt", url, anon, svc)).toBeNull();
  });

  it("rejects an invalid JWT", async () => {
    globalThis.fetch = (async () => new Response("", { status: 401 })) as typeof fetch;
    expect(await verifyAdminJwt("bad", url, anon, svc)).toBeNull();
  });

  it("rejects a missing JWT", async () => {
    expect(await verifyAdminJwt("", url, anon, svc)).toBeNull();
  });
});
