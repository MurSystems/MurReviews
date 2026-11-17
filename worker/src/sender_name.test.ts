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
    LINK_DOMAIN: "https://m.test",
    SEND_THROTTLE_MS: "0",
    CORS_ORIGINS: "https://app.example.com",
  } as Env;
}

function stubFetch(preview: any = null): Call[] {
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
    if (url.endsWith("/rpc/admin_set_sender_name")) return new Response("");
    if (url.endsWith("/rpc/admin_preview_message")) {
      return Response.json([
        preview ?? {
          example_text: "Hi Mia, it's Azlaan from Mur Demo.",
          gsm7_length: 36,
          segments: 1,
          template: "Hi {first_name}",
        },
      ]);
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  return calls;
}

function rpc(calls: Call[], name: string): Call[] {
  return calls.filter((c) => c.url.endsWith(`/rpc/${name}`));
}

function request(path: string, method: string, body?: unknown): Request {
  return new Request(`https://m.example.com${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer jwt",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("POST /admin/businesses/:id/sender-name", () => {
  it("saves the trimmed owner first name", async () => {
    const calls = stubFetch();
    const res = await worker.fetch(
      request("/admin/businesses/biz-1/sender-name", "POST", { sender_name: "  Azlaan " }),
      stubEnv(),
    );

    expect(res.status).toBe(200);
    expect(rpc(calls, "admin_set_sender_name")[0].body).toMatchObject({
      p_business_id: "biz-1",
      p_sender_name: "Azlaan",
      p_admin_id: "admin-1",
    });
  });

  it("clears the name when the field is empty", async () => {
    const calls = stubFetch();
    const res = await worker.fetch(
      request("/admin/businesses/biz-1/sender-name", "POST", { sender_name: "" }),
      stubEnv(),
    );

    expect(res.status).toBe(200);
    expect(rpc(calls, "admin_set_sender_name")[0].body.p_sender_name).toBe(null);
  });

  it("refuses an overlong name before calling the database", async () => {
    const calls = stubFetch();
    const res = await worker.fetch(
      request("/admin/businesses/biz-1/sender-name", "POST", {
        sender_name: "x".repeat(41),
      }),
      stubEnv(),
    );

    expect(res.status).toBe(400);
    expect(rpc(calls, "admin_set_sender_name")).toHaveLength(0);
  });
});

describe("GET /admin/businesses/:id/message-example", () => {
  it("renders the example with the link domain and returns its length", async () => {
    const calls = stubFetch();
    const res = await worker.fetch(
      request("/admin/businesses/biz-1/message-example", "GET"),
      stubEnv(),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ gsm7_length: 36, segments: 1 });
    expect(rpc(calls, "admin_preview_message")[0].body).toMatchObject({
      p_business_id: "biz-1",
      p_link_domain: "https://m.test",
    });
  });
});
