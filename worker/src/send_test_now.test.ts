import { describe, it, expect, vi, afterEach } from "vitest";
import worker, { type Env } from "./index";

// index.ts imports the Workers runtime module; stub it so the worker can be
// exercised in a plain Node test.
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

const created = {
  message_id: "msg-1",
  customer_id: "cust-1",
  send_mode: "sms_provider",
  business_name: "Mur Demo",
  mobile: "+61411875278",
};

const prep = {
  mobile: "+61411875278",
  rendered_text: "Hi Azlaan, thanks for choosing Mur Demo. https://m.example/r/tok Reply STOP to opt out",
  send_mode: "sms_provider",
  business_id: "biz-1",
  sender_number: null,
};

type Call = { url: string; body: any };

function stubEnv(overrides: Partial<Env> = {}): Env {
  return {
    SUPABASE_URL: "https://x.supabase.co",
    SUPABASE_ANON_KEY: "anon-key",
    SUPABASE_SERVICE_ROLE_KEY: "service-key",
    SEND_ALLOWLIST: "+61411875278",
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

function stubFetch(opts: { sendOk?: boolean; prepRow?: any; createdRow?: any } = {}): Call[] {
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

    if (url.endsWith("/auth/v1/user")) {
      return Response.json({ id: "admin-1" });
    }
    if (url.includes("/rest/v1/profiles")) {
      return Response.json([{ id: "admin-1" }]);
    }
    if (url.endsWith("/rpc/admin_create_test_message")) {
      return Response.json([opts.createdRow ?? created]);
    }
    if (url.endsWith("/rpc/prepare_send")) {
      return Response.json([opts.prepRow ?? prep]);
    }
    if (url.endsWith("/rpc/mark_sent") || url.endsWith("/rpc/mark_failed")) {
      return new Response("");
    }
    if (url.startsWith("https://api.mobilemessage.com.au")) {
      return new Response("", { status: opts.sendOk === false ? 500 : 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  return calls;
}

function testRequest(body: unknown = {}): Request {
  return new Request("https://m.example.com/admin/businesses/biz-1/send-test-now", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer jwt",
    },
    body: JSON.stringify(body),
  });
}

function rpcCalls(calls: Call[], name: string): Call[] {
  return calls.filter((c) => c.url.endsWith(`/rpc/${name}`));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("POST /admin/businesses/:id/send-test-now", () => {
  it("sends one live text to the allowlisted number and records it as a mock", async () => {
    const calls = stubFetch();
    const res = await worker.fetch(
      testRequest(),
      stubEnv({ SENDER_LIVE: "true" }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      live: true,
      mobile: "+61411875278",
      send_mode: "sms_provider",
    });

    expect(rpcCalls(calls, "admin_create_test_message")[0].body).toMatchObject({
      p_business_id: "biz-1",
      p_mobile: "+61411875278",
      p_admin_id: "admin-1",
    });
    expect(rpcCalls(calls, "mark_sent")[0].body).toMatchObject({
      p_message_id: "msg-1",
      p_mock: true,
    });
    expect(
      calls.some((c) => c.url.startsWith("https://api.mobilemessage.com.au")),
    ).toBe(true);
  });

  it("defaults to the allowlisted number and rejects any other number", async () => {
    const calls = stubFetch();
    const res = await worker.fetch(
      testRequest({ mobile: "+61499999999" }),
      stubEnv({ SENDER_LIVE: "true" }),
    );

    expect(res.status).toBe(403);
    expect(rpcCalls(calls, "admin_create_test_message")).toHaveLength(0);
    expect(
      calls.some((c) => c.url.startsWith("https://api.mobilemessage.com.au")),
    ).toBe(false);
  });

  it("refuses when no allowlisted number is configured", async () => {
    const calls = stubFetch();
    const res = await worker.fetch(
      testRequest(),
      stubEnv({ SEND_ALLOWLIST: "" }),
    );

    expect(res.status).toBe(400);
    expect(rpcCalls(calls, "admin_create_test_message")).toHaveLength(0);
  });

  it("reports live=false and sends nothing when SENDER_LIVE is off", async () => {
    const calls = stubFetch();
    const res = await worker.fetch(testRequest(), stubEnv());

    expect(res.status).toBe(200);
    expect(((await res.json()) as { live: boolean }).live).toBe(false);
    expect(
      calls.some((c) => c.url.startsWith("https://api.mobilemessage.com.au")),
    ).toBe(false);
    expect(rpcCalls(calls, "mark_sent")[0].body.p_mock).toBe(true);
  });

  it("rate limits repeat test sends", async () => {
    const calls = stubFetch();
    const env = stubEnv({
      RATE_LIMITER: {
        idFromName: (name: string) => name,
        get: () => ({ check: async () => false }),
      } as unknown as Env["RATE_LIMITER"],
    });
    const res = await worker.fetch(testRequest(), env);

    expect(res.status).toBe(429);
    expect(rpcCalls(calls, "admin_create_test_message")).toHaveLength(0);
  });

  it("marks the message failed when the provider rejects it", async () => {
    const calls = stubFetch({ sendOk: false });
    const res = await worker.fetch(
      testRequest(),
      stubEnv({ SENDER_LIVE: "true" }),
    );

    expect(res.status).toBe(502);
    expect(rpcCalls(calls, "mark_failed")[0].body).toMatchObject({
      p_message_id: "msg-1",
      p_retryable: true,
    });
    expect(rpcCalls(calls, "mark_sent")).toHaveLength(0);
  });
});
