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
    MOBILE_MESSAGE_USERNAME: "user",
    MOBILE_MESSAGE_PASSWORD: "pass",
  } as Env;
}

function stubFetch(opts: {
  sender?: string | null;
  providers?: string[];
  providerOk?: boolean;
} = {}): Call[] {
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
    if (url.includes("/rest/v1/businesses?")) {
      return Response.json([{ sender_number: opts.sender ?? null }]);
    }
    if (url === "https://api.mobilemessage.com.au/v1/senders") {
      if (opts.providerOk === false) return new Response("", { status: 500 });
      return Response.json({
        status: "complete",
        results: (opts.providers ?? ["61485900133", "61411875278"]).map((s) => ({
          sender: s,
          type: s === "61485900133" ? "shared" : "own",
          label: s,
        })),
      });
    }
    if (url.includes("/rpc/admin_set_sender_number")) return new Response("");
    if (url.includes("/rpc/admin_mark_sender_verified")) return new Response("");
    if (url.includes("/rpc/admin_toggle_onboarding")) return new Response("");
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  return calls;
}

function post(path: string, body: unknown): Request {
  return new Request(`https://m.example.com${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer jwt",
    },
    body: JSON.stringify(body),
  });
}

function rpc(calls: Call[], name: string): Call[] {
  return calls.filter((c) => c.url.endsWith(`/rpc/${name}`));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("POST /admin/businesses/:id/sender-number", () => {
  it("stores the sender mobile in E.164 form", async () => {
    const calls = stubFetch();
    const res = await worker.fetch(
      post("/admin/businesses/biz-1/sender-number", { sender_number: "0411 875 278" }),
      stubEnv(),
    );

    expect(res.status).toBe(200);
    expect(rpc(calls, "admin_set_sender_number")[0].body).toMatchObject({
      p_business_id: "biz-1",
      p_sender_number: "+61411875278",
      p_admin_id: "admin-1",
    });
  });

  it("clears the sender when the field is empty", async () => {
    const calls = stubFetch();
    const res = await worker.fetch(
      post("/admin/businesses/biz-1/sender-number", { sender_number: "" }),
      stubEnv(),
    );

    expect(res.status).toBe(200);
    expect(rpc(calls, "admin_set_sender_number")[0].body.p_sender_number).toBe(null);
  });

  it("rejects a landline or junk number before calling the database", async () => {
    for (const sender_number of ["02 9000 0000", "abc"]) {
      const calls = stubFetch();
      const res = await worker.fetch(
        post("/admin/businesses/biz-1/sender-number", { sender_number }),
        stubEnv(),
      );
      expect(res.status).toBe(400);
      expect(rpc(calls, "admin_set_sender_number")).toHaveLength(0);
    }
  });
});

describe("POST /admin/businesses/:id/check-sender", () => {
  it("marks a sender verified when it appears in Mobile Message", async () => {
    const calls = stubFetch({ sender: "+61411875278" });
    const res = await worker.fetch(
      post("/admin/businesses/biz-1/check-sender", {}),
      stubEnv(),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ verified: true });
    expect(rpc(calls, "admin_mark_sender_verified")[0].body).toMatchObject({
      p_business_id: "biz-1",
      p_verified: true,
      p_admin_id: "admin-1",
    });
  });

  it("marks it unverified when the number is not in the list", async () => {
    const calls = stubFetch({ sender: "+61499998888", providers: ["61485900133"] });
    const res = await worker.fetch(
      post("/admin/businesses/biz-1/check-sender", {}),
      stubEnv(),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ verified: false });
    expect(rpc(calls, "admin_mark_sender_verified")[0].body.p_verified).toBe(false);
  });

  it("asks for a sender first when the business has none", async () => {
    const calls = stubFetch({ sender: null });
    const res = await worker.fetch(
      post("/admin/businesses/biz-1/check-sender", {}),
      stubEnv(),
    );

    expect(res.status).toBe(400);
    expect(rpc(calls, "admin_mark_sender_verified")).toHaveLength(0);
  });

  it("returns a plain reason when Mobile Message cannot be reached", async () => {
    stubFetch({ sender: "+61411875278", providerOk: false });
    const res = await worker.fetch(
      post("/admin/businesses/biz-1/check-sender", {}),
      stubEnv(),
    );

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({
      error: expect.stringContaining("Could not reach Mobile Message"),
    });
  });
});

describe("POST /admin/businesses/:id/onboarding", () => {
  it("ticks and unticks one checklist item", async () => {
    for (const done of [true, false]) {
      const calls = stubFetch();
      const res = await worker.fetch(
        post("/admin/businesses/biz-1/onboarding", {
          item: "payment_taken",
          done,
        }),
        stubEnv(),
      );
      expect(res.status).toBe(200);
      expect(rpc(calls, "admin_toggle_onboarding")[0].body).toMatchObject({
        p_business_id: "biz-1",
        p_item: "payment_taken",
        p_done: done,
      });
    }
  });
});
