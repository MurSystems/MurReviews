import { describe, it, expect, vi, afterEach } from "vitest";
import worker, { type Env } from "./index";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

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
    ...overrides,
  } as Env;
}

function stubFetch(
  opts: { owner?: string | null; created?: any[] } = {},
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

    if (url.endsWith("/auth/v1/user")) return Response.json({ id: "admin-1" });
    if (url.includes("/rest/v1/profiles")) return Response.json([{ id: "admin-1" }]);
    if (url.endsWith("/rpc/admin_find_owner")) {
      return new Response(
        opts.owner === undefined || opts.owner === null
          ? "null"
          : JSON.stringify(opts.owner),
      );
    }
    if (url.endsWith("/rpc/admin_create_business")) {
      return Response.json(opts.created ?? [{ id: "biz-new" }]);
    }
    if (url.endsWith("/rpc/admin_record_review_snapshot")) return new Response("");
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  return calls;
}

function request(path: string, body: unknown): Request {
  return new Request(`https://m.example.com${path}`, {
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

describe("POST /admin/businesses/:id/review-count", () => {
  it("records a manual Google review count with its date and rating", async () => {
    const calls = stubFetch();
    const res = await worker.fetch(
      request("/admin/businesses/biz-1/review-count", {
        review_count: 42,
        snapshot_date: "2026-11-17",
        rating: 4.6,
      }),
      stubEnv(),
    );

    expect(res.status).toBe(200);
    expect(rpcCalls(calls, "admin_record_review_snapshot")[0].body).toMatchObject({
      p_business_id: "biz-1",
      p_review_count: 42,
      p_snapshot_date: "2026-11-17",
      p_rating: 4.6,
      p_admin_id: "admin-1",
    });
  });

  it("allows a count with no rating and no date", async () => {
    const calls = stubFetch();
    const res = await worker.fetch(
      request("/admin/businesses/biz-1/review-count", { review_count: 0 }),
      stubEnv(),
    );

    expect(res.status).toBe(200);
    expect(rpcCalls(calls, "admin_record_review_snapshot")[0].body).toMatchObject({
      p_review_count: 0,
      p_snapshot_date: null,
      p_rating: null,
    });
  });

  it("rejects a negative or non-numeric count before calling the database", async () => {
    for (const review_count of [-1, "abc", 1.5]) {
      const calls = stubFetch();
      const res = await worker.fetch(
        request("/admin/businesses/biz-1/review-count", { review_count }),
        stubEnv(),
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        error: "Review count must be zero or more.",
      });
      expect(rpcCalls(calls, "admin_record_review_snapshot")).toHaveLength(0);
    }
  });

  it("rejects a malformed date and an out-of-range rating", async () => {
    const badDate = stubFetch();
    const dateRes = await worker.fetch(
      request("/admin/businesses/biz-1/review-count", {
        review_count: 3,
        snapshot_date: "17/11/2026",
      }),
      stubEnv(),
    );
    expect(dateRes.status).toBe(400);

    const badRating = stubFetch();
    const ratingRes = await worker.fetch(
      request("/admin/businesses/biz-1/review-count", {
        review_count: 3,
        rating: 6,
      }),
      stubEnv(),
    );
    expect(ratingRes.status).toBe(400);
    expect(rpcCalls(badDate, "admin_record_review_snapshot")).toHaveLength(0);
    expect(rpcCalls(badRating, "admin_record_review_snapshot")).toHaveLength(0);
  });
});

describe("POST /admin/businesses with a starting review count", () => {
  it("passes the count entered at creation to the database", async () => {
    const calls = stubFetch({ owner: "owner-1" });
    const res = await worker.fetch(
      request("/admin/businesses", {
        name: "Harbour Dental",
        place_id: "ChIJ123",
        owner_email: "owner@example.com",
        review_count: "42",
      }),
      stubEnv(),
    );

    expect(res.status).toBe(200);
    expect(rpcCalls(calls, "admin_create_business")[0].body).toMatchObject({
      p_name: "Harbour Dental",
      p_owner_id: "owner-1",
      p_review_count: 42,
    });
  });

  it("rejects an invalid starting count before creating an owner", async () => {
    const calls = stubFetch({ owner: null });
    const res = await worker.fetch(
      request("/admin/businesses", {
        name: "Harbour Dental",
        place_id: "ChIJ123",
        owner_email: "owner@example.com",
        review_count: "many",
      }),
      stubEnv(),
    );

    expect(res.status).toBe(400);
    expect(rpcCalls(calls, "admin_create_business")).toHaveLength(0);
    expect(calls.some((c) => c.url.endsWith("/auth/v1/admin/generate_link"))).toBe(false);
  });
});
