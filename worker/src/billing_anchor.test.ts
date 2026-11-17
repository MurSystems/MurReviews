import { describe, it, expect, vi, afterEach } from "vitest";
import worker, { type Env } from "./index";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

type Call = { url: string; body: any };

function stubEnv(): Env {
  return {
    SUPABASE_URL: "https://x.supabase.co",
    SUPABASE_ANON_KEY: "anon-key",
    SUPABASE_SERVICE_ROLE_KEY: "service-key",
    SEND_ALLOWLIST: "",
    LINK_DOMAIN: "https://m.example",
    SEND_THROTTLE_MS: "0",
    CORS_ORIGINS: "https://app.example.com",
  } as Env;
}

function stubFetch(): Call[] {
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

    if (url.endsWith("/auth/v1/user")) return Response.json({ id: "admin-1" });
    if (url.includes("/rest/v1/profiles")) return Response.json([{ id: "admin-1" }]);
    if (url.endsWith("/rpc/admin_set_billing_anchor")) return new Response("");
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  return calls;
}

function request(body: unknown): Request {
  return new Request("https://m.example.com/admin/businesses/biz-1/billing-anchor", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer jwt",
    },
    body: JSON.stringify(body),
  });
}

function rpcCalls(calls: Call[]): Call[] {
  return calls.filter((c) => c.url.endsWith("/rpc/admin_set_billing_anchor"));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("POST /admin/businesses/:id/billing-anchor", () => {
  it("saves the billing anchor date", async () => {
    const calls = stubFetch();
    const res = await worker.fetch(request({ billing_anchor: "2026-03-31" }), stubEnv());

    expect(res.status).toBe(200);
    expect(rpcCalls(calls)[0].body).toMatchObject({
      p_business_id: "biz-1",
      p_anchor: "2026-03-31",
      p_admin_id: "admin-1",
    });
  });

  it("rejects a missing or malformed date before calling the database", async () => {
    for (const billing_anchor of [undefined, "", "31/03/2026", "2026-3-1"]) {
      const calls = stubFetch();
      const res = await worker.fetch(request({ billing_anchor }), stubEnv());
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "Choose a billing date." });
      expect(rpcCalls(calls)).toHaveLength(0);
    }
  });
});
