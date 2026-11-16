import { DurableObject } from "cloudflare:workers";
import { isAllowed, verifyHmacSignature } from "./guard";

export interface Env {
  RATE_LIMITER: DurableObjectNamespace<RateLimiter>;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  SEND_ALLOWLIST: string; // comma-separated E.164 numbers
  PRODUCTION?: string; // only exact "true" means production
  LINK_DOMAIN: string; // e.g. https://m.mursystems123.workers.dev
  SEND_THROTTLE_MS: string; // e.g. "3000"
  SMSGATE_WEBHOOK_SECRET?: string; // HMAC key for inbound webhooks
  SMSGATE_LIVE?: string; // "true" to make real SMSGate calls (not yet)
}

const BOT_UA =
  /facebookexternalhit|twitterbot|slackbot|whatsapp|telegrambot|discordbot|linkedinbot|pinterest|googlebot|bingbot|duckduckbot|applebot|bot|crawler|spider|scanner|preview|curl|wget|python|go-http-client|postman|insomnia|okhttp/i;

export class RateLimiter extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS hits (ts INTEGER NOT NULL)",
      );
    });
  }

  async check(limit: number, windowMs: number): Promise<boolean> {
    const now = Date.now();
    const cutoff = now - windowMs;
    this.ctx.storage.sql.exec("DELETE FROM hits WHERE ts < ?", cutoff);
    const count = this.ctx.storage.sql.exec(
      "SELECT COUNT(*) AS c FROM hits",
    ).one().c as number;
    if (count >= limit) return false;
    this.ctx.storage.sql.exec("INSERT INTO hits (ts) VALUES (?)", now);
    return true;
  }
}

async function supabaseRpc(
  env: Env,
  fn: string,
  params: Record<string, unknown>,
): Promise<any> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    throw new Error(`Supabase RPC ${fn} failed: ${res.status}`);
  }
  return await res.json();
}

// ---------- senders (mock until a real gateway is paired) ----------

interface SmsGateClient {
  send(to: string, text: string): Promise<{ id: string }>;
}

class MockSmsGateClient implements SmsGateClient {
  sent: { to: string; text: string }[] = [];
  async send(to: string, text: string): Promise<{ id: string }> {
    this.sent.push({ to, text });
    console.log(`[mock-smsgate] to=${to} text=${JSON.stringify(text)}`);
    return { id: `mock-${crypto.randomUUID()}` };
  }
}

class RealSmsGateClient implements SmsGateClient {
  constructor(
    private baseUrl: string,
    private username: string,
    private password: string,
  ) {}
  async send(to: string, text: string): Promise<{ id: string }> {
    const res = await fetch(`${this.baseUrl}/3rdparty/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${btoa(`${this.username}:${this.password}`)}`,
      },
      body: JSON.stringify({ textMessage: { text }, phoneNumbers: [to] }),
    });
    if (!res.ok) throw new Error(`SMSGate send failed: ${res.status}`);
    const data = (await res.json()) as { id?: string };
    return { id: data.id ?? "unknown" };
  }
}

async function sendSms(
  env: Env,
  mode: string,
  to: string,
  text: string,
): Promise<void> {
  if (mode === "log_only") {
    console.log(`[log-only] would send to=${to} text=${JSON.stringify(text)}`);
    return;
  }
  // demo / android_gateway / sms_provider all go through the gateway. Until
  // SMSGATE_LIVE is set, use the mock (logs and succeeds).
  const client: SmsGateClient =
    env.SMSGATE_LIVE === "true"
      ? new RealSmsGateClient(
          "https://api.sms-gate.app",
          env.SUPABASE_SERVICE_ROLE_KEY, // placeholder; real creds come later
          "unused",
        )
      : new MockSmsGateClient();
  await client.send(to, text);
}

// ---------- cron sender ----------

async function runSender(env: Env): Promise<void> {
  const claimed = await supabaseRpc(env, "claim_due_messages", {});
  const messages = Array.isArray(claimed) ? claimed : [];
  const throttleMs = Number(env.SEND_THROTTLE_MS ?? "3000") || 0;
  const allowlist = (env.SEND_ALLOWLIST ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  for (const msg of messages) {
    try {
      const prepRows = await supabaseRpc(env, "prepare_send", {
        p_message_id: msg.id,
        p_link_domain: env.LINK_DOMAIN,
      });
      const prep = prepRows?.[0];
      if (!prep) {
        await supabaseRpc(env, "mark_failed", {
          p_message_id: msg.id,
          p_error: "no recipient",
          p_retryable: false,
        });
        continue;
      }

      if (!isAllowed(prep.send_mode, prep.mobile, env.PRODUCTION ?? "", allowlist)) {
        console.log(
          `[blocked] mode=${prep.send_mode} mobile=${prep.mobile} not allowlisted (non-production)`,
        );
        await supabaseRpc(env, "mark_failed", {
          p_message_id: msg.id,
          p_error: "not allowlisted",
          p_retryable: false,
        });
        continue;
      }

      await sendSms(env, prep.send_mode, prep.mobile, prep.rendered_text);
      await supabaseRpc(env, "mark_sent", {
        p_message_id: msg.id,
        p_text: prep.rendered_text,
      });
    } catch (e) {
      await supabaseRpc(env, "mark_failed", {
        p_message_id: msg.id,
        p_error: String(e),
        p_retryable: true,
      });
    }
    if (throttleMs > 0) await new Promise((r) => setTimeout(r, throttleMs));
  }
}

// ---------- webhook signature + handler ----------

async function handleWebhook(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const rawBody = await request.text();
  if (env.SMSGATE_WEBHOOK_SECRET) {
    const signature = request.headers.get("x-signature") ?? "";
    const timestamp = request.headers.get("x-timestamp") ?? "";
    const ok = await verifyHmacSignature(
      rawBody,
      timestamp,
      signature,
      env.SMSGATE_WEBHOOK_SECRET,
    );
    if (!ok) return new Response("Unauthorized", { status: 401 });
  }

  let event: any;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  const type = event.event ?? event.type ?? "";
  const deviceId = event.deviceId ?? "";

  if (type === "system:ping" || type === "system:device_start") {
    await supabaseRpc(env, "touch_gateway", { p_device_id: deviceId });
    return new Response("ok");
  }

  if (type === "sms:received") {
    await supabaseRpc(env, "handle_inbound_sms", {
      p_device_id: deviceId,
      p_from_mobile: event.sender ?? "",
      p_body: event.text ?? event.body ?? "",
    });
    return new Response("ok");
  }

  return new Response("ignored");
}

// ---------- existing link routes ----------

function isRealClick(request: Request): boolean {
  if (request.method !== "GET") return false;
  const ua = request.headers.get("user-agent") ?? "";
  return !BOT_UA.test(ua);
}

async function handleReview(
  request: Request,
  env: Env,
  token: string,
): Promise<Response> {
  const rows = await supabaseRpc(env, "handle_review", {
    p_token: token,
    p_record: isRealClick(request),
  });
  const row = rows[0];
  if (!row?.found) return new Response("Not found", { status: 404 });

  const placeId = String(row.place_id ?? "");
  return Response.redirect(
    `https://search.google.com/local/writereview?placeid=${encodeURIComponent(placeId)}`,
    302,
  );
}

const optOutFormPage = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Opt out</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; max-width: 420px; margin: 0 auto; padding: 24px; line-height: 1.4; }
  button { display: block; width: 100%; min-height: 60px; font-size: 20px; font-weight: 600; }
</style>
</head>
<body>
  <h1>Opt out of review requests?</h1>
  <p>You won't get any more review texts from this business.</p>
  <form method="POST">
    <button type="submit">Opt out</button>
  </form>
</body>
</html>`;

const optedOutPage = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Opted out</title>
</head>
<body style="font-family:system-ui,-apple-system,sans-serif;max-width:420px;margin:0 auto;padding:24px;line-height:1.4">
<h1>You're opted out</h1>
<p>You'll no longer receive review requests from this business.</p>
</body>
</html>`;

async function handleOptOut(
  request: Request,
  env: Env,
  token: string,
): Promise<Response> {
  if (request.method === "POST") {
    const rows = await supabaseRpc(env, "opt_out_by_token", { p_token: token });
    const row = rows[0];
    if (!row?.found) return new Response("Not found", { status: 404 });
    return new Response(optedOutPage, {
      headers: { "content-type": "text/html;charset=UTF-8" },
    });
  }
  return new Response(optOutFormPage, {
    headers: { "content-type": "text/html;charset=UTF-8" },
  });
}

// ---------- main ----------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/webhook") return handleWebhook(request, env);

    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
    const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(ip));
    if (!(await stub.check(100, 60_000))) {
      return new Response("Too many requests", { status: 429 });
    }

    if (path.startsWith("/r/")) return handleReview(request, env, path.slice(3));
    if (path.startsWith("/o/")) return handleOptOut(request, env, path.slice(3));
    return new Response("Not found", { status: 404 });
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await runSender(env);
  },
};
