import { describe, it, expect, vi, afterEach } from "vitest";
import worker, { type Env } from "./index";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

const URL_KEY = "url-key-for-tests";
const SIGNING_SECRET = "signing-secret-for-tests";

type Call = { url: string; body: any };

function stubEnv(overrides: Partial<Env> = {}): Env {
  return {
    SUPABASE_URL: "https://x.supabase.co",
    SUPABASE_ANON_KEY: "anon-key",
    SUPABASE_SERVICE_ROLE_KEY: "service-key",
    SEND_ALLOWLIST: "",
    LINK_DOMAIN: "https://m.example",
    SEND_THROTTLE_MS: "0",
    CORS_ORIGINS: "https://app.example.com",
    RATE_LIMITER: {
      idFromName: (name: string) => name,
      get: () => ({ check: async () => true }),
    } as unknown as Env["RATE_LIMITER"],
    ...overrides,
  } as Env;
}

function stubFetch(
  opts: { rpcFails?: boolean; matched?: boolean } = {},
): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    let body: any = null;
    if (init?.body) {
      try {
        body = JSON.parse(String(init.body));
      } catch {
        body = String(init.body);
      }
    }
    calls.push({ url, body });
    if (url.endsWith("/rpc/handle_sms_reply")) {
      if (opts.rpcFails) return new Response("boom", { status: 500 });
      return Response.json([
        {
          matched: opts.matched ?? true,
          is_stop: false,
          business_id: "biz-1",
          customer_id: "cust-1",
        },
      ]);
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  return calls;
}

function inboundBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    to: "61485900133",
    sender: "61411875278",
    message: "Yes please",
    received_at: "2026-11-17 09:41:25",
    type: "inbound",
    original_message_id: "3060142a-403e-47ab-a9a6-7be5216ecbd8",
    original_custom_ref: "msg-uuid",
    ...overrides,
  });
}

function webhookRequest(
  body: string,
  opts: { key?: string | null; headers?: Record<string, string> } = {},
): Request {
  const key = opts.key === undefined ? URL_KEY : opts.key;
  const query = key === null ? "" : `?key=${encodeURIComponent(key)}`;
  return new Request(`https://m.example.com/webhook/mobile-message${query}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(opts.headers ?? {}) },
    body,
  });
}

async function sign(body: string, timestamp: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SIGNING_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${body}`),
  );
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("POST /webhook/mobile-message", () => {
  it("refuses when neither a signing secret nor a URL key is configured", async () => {
    const calls = stubFetch();
    const res = await worker.fetch(
      webhookRequest(inboundBody(), { key: null }),
      stubEnv(),
    );

    expect(res.status).toBe(503);
    expect(calls).toHaveLength(0);
  });

  it("rejects a wrong URL key", async () => {
    const calls = stubFetch();
    const res = await worker.fetch(
      webhookRequest(inboundBody(), { key: "wrong" }),
      stubEnv({ MOBILE_MESSAGE_INBOUND_KEY: URL_KEY }),
    );

    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("stores a reply through the URL-key endpoint", async () => {
    const calls = stubFetch();
    const res = await worker.fetch(
      webhookRequest(inboundBody()),
      stubEnv({ MOBILE_MESSAGE_INBOUND_KEY: URL_KEY }),
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    const rpc = calls.find((c) => c.url.endsWith("/rpc/handle_sms_reply"));
    expect(rpc?.body).toMatchObject({
      p_to_number: "61485900133",
      p_from_mobile: "61411875278",
      p_body: "Yes please",
      p_is_unsubscribe: false,
      p_custom_ref: "msg-uuid",
      p_received_at: "2026-11-17T09:41:25.000Z",
    });
  });

  it("passes type=unsubscribe through as an opt-out", async () => {
    const calls = stubFetch();
    await worker.fetch(
      webhookRequest(inboundBody({ type: "unsubscribe", message: "no thanks" })),
      stubEnv({ MOBILE_MESSAGE_INBOUND_KEY: URL_KEY }),
    );

    const rpc = calls.find((c) => c.url.endsWith("/rpc/handle_sms_reply"));
    expect(rpc?.body.p_is_unsubscribe).toBe(true);
  });

  it("accepts a correctly signed request and rejects a stale one", async () => {
    stubFetch();
    const body = inboundBody();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = await sign(body, timestamp);

    const ok = await worker.fetch(
      webhookRequest(body, {
        key: null,
        headers: { "X-MM-Timestamp": timestamp, "X-MM-Signature": signature },
      }),
      stubEnv({ MOBILE_MESSAGE_WEBHOOK_SECRET: SIGNING_SECRET }),
    );
    expect(ok.status).toBe(200);

    const stale = String(Math.floor(Date.now() / 1000) - 3600);
    const staleSignature = await sign(body, stale);
    const rejected = await worker.fetch(
      webhookRequest(body, {
        key: null,
        headers: { "X-MM-Timestamp": stale, "X-MM-Signature": staleSignature },
      }),
      stubEnv({ MOBILE_MESSAGE_WEBHOOK_SECRET: SIGNING_SECRET }),
    );
    expect(rejected.status).toBe(401);
  });

  it("rejects a bad signature", async () => {
    stubFetch();
    const body = inboundBody();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const res = await worker.fetch(
      webhookRequest(body, {
        key: null,
        headers: { "X-MM-Timestamp": timestamp, "X-MM-Signature": "deadbeef" },
      }),
      stubEnv({ MOBILE_MESSAGE_WEBHOOK_SECRET: SIGNING_SECRET }),
    );

    expect(res.status).toBe(401);
  });

  it("ignores a payload with no sender", async () => {
    const calls = stubFetch();
    const res = await worker.fetch(
      webhookRequest(inboundBody({ sender: "" })),
      stubEnv({ MOBILE_MESSAGE_INBOUND_KEY: URL_KEY }),
    );

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(0);
  });

  it("returns 400 for invalid JSON", async () => {
    const calls = stubFetch();
    const res = await worker.fetch(
      webhookRequest("{not json"),
      stubEnv({ MOBILE_MESSAGE_INBOUND_KEY: URL_KEY }),
    );

    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("returns 500 so the provider retries when the database fails", async () => {
    const calls = stubFetch({ rpcFails: true });
    const res = await worker.fetch(
      webhookRequest(inboundBody()),
      stubEnv({ MOBILE_MESSAGE_INBOUND_KEY: URL_KEY }),
    );

    expect(res.status).toBe(500);
    expect(calls.some((c) => c.url.endsWith("/rpc/handle_sms_reply"))).toBe(true);
  });

  it("returns 405 for a GET", async () => {
    const res = await worker.fetch(
      new Request("https://m.example.com/webhook/mobile-message?key=" + URL_KEY),
      stubEnv({ MOBILE_MESSAGE_INBOUND_KEY: URL_KEY }),
    );

    expect(res.status).toBe(405);
  });
});
