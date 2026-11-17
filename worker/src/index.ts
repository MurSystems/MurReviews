import { DurableObject } from "cloudflare:workers";
import {
  isAllowed,
  verifyHmacSignature,
  verifyAdminJwt,
  withCors,
  allowedOrigin,
  corsHeaders,
  generateAuthLink as guardAuthLink,
} from "./guard";

export interface Env {
  RATE_LIMITER: DurableObjectNamespace<RateLimiter>;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  SEND_ALLOWLIST: string; // comma-separated E.164 numbers
  PRODUCTION?: string; // only exact "true" means production
  LINK_DOMAIN: string; // e.g. https://m.mursystems123.workers.dev
  SEND_THROTTLE_MS: string; // e.g. "3000"
  CORS_ORIGINS: string; // comma-separated allowed browser origins
  SMSGATE_WEBHOOK_SECRET?: string; // HMAC key for inbound webhooks
  SENDER_LIVE?: string; // "true" to actually send (generic live switch)
  MOBILE_MESSAGE_USERNAME?: string;
  MOBILE_MESSAGE_PASSWORD?: string;
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
  const text = await res.text();
  return text ? JSON.parse(text) : null;
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

class MobileMessageClient {
  constructor(
    private username: string,
    private password: string,
  ) {}
  async send(to: string, text: string, sender: string): Promise<void> {
    const res = await fetch("https://api.mobilemessage.com.au/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${btoa(`${this.username}:${this.password}`)}`,
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify({ messages: [{ to, message: text, sender }] }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Mobile Message send failed (${res.status}): ${body}`);
    }
  }
}

async function sendSms(
  env: Env,
  mode: string,
  to: string,
  text: string,
  sender?: string,
): Promise<void> {
  if (mode === "log_only") {
    console.log(`[log-only] would send to=${to} text=${JSON.stringify(text)}`);
    return;
  }
  if (env.SENDER_LIVE !== "true") {
    console.log(
      `[mock] mode=${mode} to=${to} sender=${sender ?? "default"} text=${JSON.stringify(text)}`,
    );
    return;
  }
  if (mode === "sms_provider") {
    const client = new MobileMessageClient(
      env.MOBILE_MESSAGE_USERNAME ?? "",
      env.MOBILE_MESSAGE_PASSWORD ?? "",
    );
    await client.send(to, text, sender || "MurSystems");
    return;
  }
  throw new Error(`${mode} live sending is not implemented yet`);
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

      await sendSms(env, prep.send_mode, prep.mobile, prep.rendered_text, prep.sender_number);
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

// ---------- admin routes ----------

async function verifyAdmin(
  request: Request,
  env: Env,
): Promise<{ userId: string } | null> {
  const jwt = (request.headers.get("authorization") ?? "").replace(
    /^Bearer\s+/i,
    "",
  );
  const userId = await verifyAdminJwt(
    jwt,
    env.SUPABASE_URL,
    env.SUPABASE_ANON_KEY,
    env.SUPABASE_SERVICE_ROLE_KEY,
  );
  return userId ? { userId } : null;
}

async function supabaseGet(env: Env, path: string): Promise<any> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!res.ok) throw new Error(`Supabase GET ${path} failed: ${res.status}`);
  return await res.json();
}

async function generateAuthLink(
  env: Env,
  email: string,
  type: "invite" | "recovery",
): Promise<{ userId: string; link: string }> {
  return guardAuthLink(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, email, type);
}

// A new owner gets an invite (they set a password); an existing owner gets a
// password-reset link instead.
async function generateLoginLink(
  env: Env,
  email: string,
): Promise<{ userId: string; link: string }> {
  const existing = await supabaseRpc(env, "admin_find_owner", {
    p_email: email,
  });
  return existing
    ? generateAuthLink(env, email, "recovery")
    : generateAuthLink(env, email, "invite");
}

async function handleAdmin(
  request: Request,
  env: Env,
  userId: string,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  try {
    if (path === "/admin/businesses" && method === "GET") {
      const rows = await supabaseRpc(env, "admin_list_businesses", {});
      return Response.json(rows ?? []);
    }
    if (path === "/admin/businesses" && method === "POST") {
      const body = (await request.json()) as Record<string, any>;
      let ownerId = await supabaseRpc(env, "admin_find_owner", {
        p_email: body.owner_email,
      });
      let loginLink: string | null = null;
      if (!ownerId) {
        // Create the owner and send a "set your password" invite.
        const g = await generateAuthLink(env, body.owner_email, "invite");
        ownerId = g.userId;
        loginLink = g.link;
      }
      const rows = await supabaseRpc(env, "admin_create_business", {
        p_name: body.name,
        p_place_id: body.place_id,
        p_timezone: body.timezone ?? "Australia/Melbourne",
        p_send_mode: body.send_mode ?? "sms_provider",
        p_delay_minutes: body.delay_minutes ?? 60,
        p_owner_id: ownerId,
        p_admin_id: userId,
      });
      return Response.json({ ...(rows?.[0] ?? {}), login_link: loginLink });
    }
    if (
      path.startsWith("/admin/businesses/") &&
      path.endsWith("/status") &&
      method === "POST"
    ) {
      const id = path.split("/")[3];
      const body = (await request.json()) as Record<string, any>;
      await supabaseRpc(env, "admin_set_business_status", {
        p_business_id: id,
        p_status: body.status,
        p_trial_cap: body.trial_cap ?? null,
        p_admin_id: userId,
      });
      return Response.json({ ok: true });
    }
    if (path === "/admin/demo-send" && method === "POST") {
      const body = (await request.json()) as Record<string, any>;
      const rows = await supabaseRpc(env, "admin_demo_send", {
        p_place_id: body.place_id,
        p_mobile: body.mobile,
        p_admin_id: userId,
      });
      return Response.json(rows?.[0] ?? null);
    }
    if (path === "/admin/generate-login-link" && method === "POST") {
      const body = (await request.json()) as Record<string, any>;
      const email = String(body.email ?? "").trim();
      if (!email) return new Response("Bad request", { status: 400 });
      const g = await generateLoginLink(env, email);
      return Response.json({ link: g.link });
    }
    if (path === "/admin/send-password-reset" && method === "POST") {
      const body = (await request.json()) as Record<string, any>;
      const email = String(body.email ?? "").trim();
      if (!email) return new Response("Bad request", { status: 400 });
      const g = await generateAuthLink(env, email, "recovery");
      return Response.json({ link: g.link });
    }
    if (path === "/admin/audit" && method === "GET") {
      const rows = await supabaseRpc(env, "admin_get_audit", {});
      return Response.json(rows ?? []);
    }
    if (
      path.startsWith("/admin/businesses/") &&
      path.endsWith("/activity") &&
      method === "GET"
    ) {
      const id = path.split("/")[3];
      const [messages, replies] = await Promise.all([
        supabaseGet(
          env,
          `messages?business_id=eq.${id}&select=id,status,mock,message_text,sent_at,clicked_at,created_at,customers(first_name,mobile)&order=created_at.desc&limit=50`,
        ),
        supabaseGet(
          env,
          `replies?business_id=eq.${id}&select=id,from_mobile,body,received_at&order=received_at.desc&limit=50`,
        ),
      ]);
      return Response.json({ messages, replies });
    }
    return new Response("Not found", { status: 404 });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 400 });
  }
}

// ---------- main ----------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const allowOrigin = allowedOrigin(request, env.CORS_ORIGINS ?? "");
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(allowOrigin) });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/webhook") return handleWebhook(request, env);

    if (path.startsWith("/admin/")) {
      const admin = await verifyAdmin(request, env);
      if (!admin) {
        return withCors(new Response("Unauthorized", { status: 401 }), allowOrigin);
      }
      return withCors(await handleAdmin(request, env, admin.userId), allowOrigin);
    }

    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
    const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(ip));
    if (!(await stub.check(100, 60_000))) {
      return withCors(new Response("Too many requests", { status: 429 }), allowOrigin);
    }

    if (path.startsWith("/r/")) {
      return withCors(await handleReview(request, env, path.slice(3)), allowOrigin);
    }
    if (path.startsWith("/o/")) {
      return withCors(await handleOptOut(request, env, path.slice(3)), allowOrigin);
    }
    return withCors(new Response("Not found", { status: 404 }), allowOrigin);
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await runSender(env);
  },
};
