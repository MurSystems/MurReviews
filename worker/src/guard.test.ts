import { describe, it, expect, vi, afterEach } from "vitest";
import {
  isAllowed,
  isAllowlisted,
  isMockSend,
  verifyHmacSignature,
  verifyAdminJwt,
  verifyUserJwt,
  parseWebhookEvent,
  normaliseAuMobile,
  withCors,
  allowedOrigin,
  generateAuthLink,
  basicAuth,
  sendFailureReason,
  adminFailureReason,
} from "./guard";

describe("basicAuth", () => {
  it("encodes ASCII credentials", () => {
    expect(basicAuth("user", "pass")).toBe("Basic dXNlcjpwYXNz");
  });
  it("encodes non-Latin1 credentials as UTF-8 instead of throwing", () => {
    expect(() => basicAuth("user", "pässwörd✓")).not.toThrow();
    expect(basicAuth("user", "pässwörd✓")).toBe(
      `Basic ${Buffer.from("user:pässwörd✓", "utf8").toString("base64")}`,
    );
  });
});

describe("sendFailureReason", () => {
  it("explains a rejected provider login", () => {
    expect(
      sendFailureReason("Mobile Message send failed (401): Unauthorized"),
    ).toContain("rejected the login");
  });
  it("includes a provider's rejection detail", () => {
    expect(
      sendFailureReason("Mobile Message send failed (422): sender not verified"),
    ).toBe("Mobile Message rejected the text: sender not verified");
  });
  it("explains an unreachable provider", () => {
    expect(sendFailureReason("TypeError: fetch failed")).toContain(
      "could not be reached",
    );
  });
});

describe("adminFailureReason", () => {
  it("points at the database key when Supabase rejects it", () => {
    expect(
      adminFailureReason("Supabase RPC admin_list_businesses failed: 401"),
    ).toContain("SUPABASE_SERVICE_ROLE_KEY");
  });
  it("points at migrations when a function is missing", () => {
    expect(
      adminFailureReason("Supabase RPC admin_list_businesses failed: 404"),
    ).toContain("migrations");
  });
});

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

describe("isAllowlisted", () => {
  it("accepts only a number on the allowlist", () => {
    expect(isAllowlisted("+61411875278", ["+61411875278"])).toBe(true);
    expect(isAllowlisted("+61411875278", ["+61499999999"])).toBe(false);
    expect(isAllowlisted("+61411875278", [])).toBe(false);
  });
});

describe("isMockSend", () => {
  it("treats log_only as a mock even when live", () => {
    expect(isMockSend("log_only", "true")).toBe(true);
  });
  it("treats every mode as a mock while live is off", () => {
    expect(isMockSend("sms_provider", undefined)).toBe(true);
    expect(isMockSend("sms_provider", "false")).toBe(true);
    expect(isMockSend("demo", "TRUE")).toBe(true);
  });
  it("only treats a live sms_provider/android_gateway send as real", () => {
    expect(isMockSend("sms_provider", "true")).toBe(false);
    expect(isMockSend("android_gateway", "true")).toBe(false);
    expect(isMockSend("android_gateway", "false")).toBe(true);
  });
});

describe("verifyUserJwt", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns the user id for a valid JWT", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ id: "user-1" }), {
        status: 200,
      })) as typeof fetch;
    expect(await verifyUserJwt("jwt", "https://x.supabase.co", "anon")).toBe(
      "user-1",
    );
  });

  it("rejects an invalid JWT", async () => {
    globalThis.fetch = (async () =>
      new Response("", { status: 401 })) as typeof fetch;
    expect(await verifyUserJwt("bad", "https://x.supabase.co", "anon")).toBeNull();
  });

  it("rejects a missing JWT without calling Supabase", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("");
    }) as typeof fetch;
    expect(await verifyUserJwt("", "https://x.supabase.co", "anon")).toBeNull();
    expect(called).toBe(false);
  });
});

describe("parseWebhookEvent", () => {
  it("reads SMSGate cloud events (payload nested)", () => {
    expect(
      parseWebhookEvent({
        event: "sms:received",
        deviceId: "dev-1",
        payload: { sender: "+61411111111", message: "STOP" },
      }),
    ).toEqual({
      type: "sms:received",
      deviceId: "dev-1",
      fromMobile: "+61411111111",
      body: "STOP",
    });
  });

  it("reads legacy top-level events", () => {
    expect(
      parseWebhookEvent({
        type: "sms:received",
        deviceId: "dev-2",
        sender: "+61422222222",
        text: "hello",
      }),
    ).toEqual({
      type: "sms:received",
      deviceId: "dev-2",
      fromMobile: "+61422222222",
      body: "hello",
    });
  });

  it("does not throw on a ping without a payload", () => {
    expect(parseWebhookEvent({ event: "system:ping", deviceId: "d" })).toEqual({
      type: "system:ping",
      deviceId: "d",
      fromMobile: "",
      body: "",
    });
  });
});

describe("normaliseAuMobile", () => {
  it("normalises national, spaced and +61 numbers", () => {
    expect(normaliseAuMobile("0412 345 678")).toBe("+61412345678");
    expect(normaliseAuMobile("61412345678")).toBe("+61412345678");
    expect(normaliseAuMobile("+61 412 345 678")).toBe("+61412345678");
    expect(normaliseAuMobile("412345678")).toBe("+61412345678");
  });

  it("rejects landlines and junk", () => {
    expect(normaliseAuMobile("0398765432")).toBeNull();
    expect(normaliseAuMobile("12345")).toBeNull();
    expect(normaliseAuMobile(null)).toBeNull();
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

describe("withCors / allowedOrigin", () => {
  it("adds CORS headers with the allowed origin (not *)", () => {
    const res = withCors(new Response("ok"), "http://localhost:5173");
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:5173",
    );
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    expect(res.headers.get("access-control-allow-headers")).toContain(
      "Authorization",
    );
  });

  it("allowedOrigin returns only an origin on the list", () => {
    const ok = new Request("http://x", {
      headers: { origin: "http://localhost:5173" },
    });
    expect(
      allowedOrigin(ok, "http://localhost:5173,https://app.example.com"),
    ).toBe("http://localhost:5173");

    const bad = new Request("http://x", {
      headers: { origin: "https://evil.example.com" },
    });
    expect(allowedOrigin(bad, "http://localhost:5173")).toBe("");
  });
});

describe("generateAuthLink", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sends an invite link (set password) for type invite", async () => {
    let body = "";
    globalThis.fetch = (async (_i, init) => {
      body = String(init?.body);
      return new Response(JSON.stringify({ id: "u1", action_link: "https://x" }), {
        status: 200,
      });
    }) as typeof fetch;
    const r = await generateAuthLink("https://x", "svc", "a@b.com", "invite");
    expect(JSON.parse(body).type).toBe("invite");
    expect(r.userId).toBe("u1");
  });

  it("sends a recovery link for type recovery", async () => {
    let body = "";
    globalThis.fetch = (async (_i, init) => {
      body = String(init?.body);
      return new Response(JSON.stringify({ id: "u1", action_link: "https://x" }), {
        status: 200,
      });
    }) as typeof fetch;
    await generateAuthLink("https://x", "svc", "a@b.com", "recovery");
    expect(JSON.parse(body).type).toBe("recovery");
  });
});
