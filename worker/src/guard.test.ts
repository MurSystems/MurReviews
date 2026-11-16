import { describe, it, expect } from "vitest";
import { isAllowed, verifyHmacSignature } from "./guard";

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
