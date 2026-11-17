import { describe, it, expect, vi, afterEach } from "vitest";
import worker, { type Env } from "./index";

// index.ts imports the Workers runtime module; stub it so the worker can be
// exercised in a plain Node test.
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

const baseEnv = {
  SUPABASE_URL: "https://x.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-key",
  SEND_ALLOWLIST: "",
  LINK_DOMAIN: "https://m.example.com",
  SEND_THROTTLE_MS: "0",
  CORS_ORIGINS: "https://app.example.com",
} as unknown as Env;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("review tracking without GOOGLE_PLACES_API_KEY", () => {
  it("skips the snapshot cron cleanly without any network calls", async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("unexpected network call");
    });
    vi.stubGlobal("fetch", fetchSpy);

    await expect(
      worker.scheduled({ cron: "0 1 * * *" } as ScheduledController, baseEnv),
    ).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("treats a blank key as not connected", async () => {
    const res = await worker.fetch(new Request("https://m.example.com/status"), {
      ...baseEnv,
      GOOGLE_PLACES_API_KEY: "   ",
    } as Env);
    expect(await res.json()).toEqual({
      places_connected: false,
      sender_live: false,
    });
  });

  it("reports review tracking as not connected", async () => {
    const res = await worker.fetch(
      new Request("https://m.example.com/status"),
      baseEnv,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      places_connected: false,
      sender_live: false,
    });
  });

  it("reports connected once the key is set", async () => {
    const res = await worker.fetch(
      new Request("https://m.example.com/status", {
        headers: { origin: "https://app.example.com" },
      }),
      { ...baseEnv, GOOGLE_PLACES_API_KEY: "places-key" } as Env,
    );
    expect(await res.json()).toEqual({
      places_connected: true,
      sender_live: false,
    });
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://app.example.com",
    );
  });
});
