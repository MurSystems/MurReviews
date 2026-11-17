import { describe, it, expect, vi, afterEach } from "vitest";
import worker, { type Env } from "./index";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

const baseEnv = {
  SUPABASE_URL: "https://x.supabase.co",
  SUPABASE_ANON_KEY: "anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "service-key",
  SEND_ALLOWLIST: "",
  LINK_DOMAIN: "https://m.example.com",
  SEND_THROTTLE_MS: "0",
  CORS_ORIGINS: "https://app.example.com",
} as unknown as Env;

function rateLimiter(allowed: boolean): Env["RATE_LIMITER"] {
  return {
    idFromName: (name: string) => name,
    get: () => ({ check: async () => allowed }),
  } as unknown as Env["RATE_LIMITER"];
}

function request(body: unknown, method = "POST") {
  return new Request("https://m.example.com/auth/is-admin", {
    method,
    headers: {
      origin: "https://app.example.com",
      "content-type": "application/json",
    },
    body: method === "POST" ? JSON.stringify(body) : undefined,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("POST /auth/is-admin", () => {
  it("returns admin true when the database lookup says so", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("true", { status: 200 })),
    );

    const res = await worker.fetch(request({ email: "ADMIN@example.com" }), {
      ...baseEnv,
      RATE_LIMITER: rateLimiter(true),
    } as Env);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ admin: true });
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://app.example.com",
    );
  });

  it("returns admin false for a non-admin or unknown email", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("false", { status: 200 })),
    );

    const res = await worker.fetch(request({ email: "owner@example.com" }), {
      ...baseEnv,
      RATE_LIMITER: rateLimiter(true),
    } as Env);

    expect(await res.json()).toEqual({ admin: false });
  });

  it("rejects a malformed email without calling the database", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const res = await worker.fetch(request({ email: "not-an-email" }), {
      ...baseEnv,
      RATE_LIMITER: rateLimiter(true),
    } as Env);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_email" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns 429 when the caller is rate limited", async () => {
    const res = await worker.fetch(request({ email: "admin@example.com" }), {
      ...baseEnv,
      RATE_LIMITER: rateLimiter(false),
    } as Env);

    expect(res.status).toBe(429);
  });

  it("rejects methods other than POST", async () => {
    const res = await worker.fetch(request(null, "GET"), {
      ...baseEnv,
      RATE_LIMITER: rateLimiter(true),
    } as Env);

    expect(res.status).toBe(405);
  });
});
