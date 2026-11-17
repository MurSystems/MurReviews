import { DurableObject } from "cloudflare:workers";
import {
  isAllowed,
  isAllowlisted,
  isMockSend,
  basicAuth,
  sendFailureReason,
  ownerFailureReason,
  adminFailureReason,
  verifyHmacSignature,
  verifyMobileMessageSignature,
  constantTimeEqual,
  verifyAdminJwt,
  verifyUserJwt,
  parseWebhookEvent,
  parseMobileMessageInbound,
  normaliseAuMobile,
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
  // Inbound replies: the account signing secret (preferred) and/or the secret
  // embedded in the webhook URL. At least one must be set or inbound webhooks
  // are refused with 503.
  MOBILE_MESSAGE_WEBHOOK_SECRET?: string;
  MOBILE_MESSAGE_INBOUND_KEY?: string;
  GOOGLE_PLACES_API_KEY?: string;
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
    private deviceId?: string,
  ) {}
  async send(to: string, text: string): Promise<{ id: string }> {
    const res = await fetch(`${this.baseUrl}/3rdparty/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: basicAuth(this.username, this.password),
      },
      body: JSON.stringify({
        textMessage: { text },
        phoneNumbers: [to],
        ...(this.deviceId ? { deviceId: this.deviceId } : {}),
      }),
    });
    const raw = await res.text();
    if (!res.ok) {
      throw new Error(`SMSGate send failed (${res.status}): ${raw.slice(0, 200)}`);
    }
    let data: { id?: string } = {};
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      // A 2xx with no JSON body still means SMSGate accepted the message.
    }
    return { id: data.id ?? "unknown" };
  }
}

type GatewayConfig = {
  baseUrl: string;
  username: string;
  password: string;
  deviceId?: string;
};

async function gatewayConfig(
  env: Env,
  businessId: string,
): Promise<GatewayConfig | null> {
  const rows = await supabaseRpc(env, "gateway_send_config", {
    p_business_id: businessId,
  });
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row?.username || !row?.password) return null;
  return {
    baseUrl: row.base_url || "https://api.sms-gate.app",
    username: row.username,
    password: row.password,
    deviceId: row.device_id || undefined,
  };
}

class MobileMessageClient {
  constructor(
    private username: string,
    private password: string,
  ) {}
  async send(
    to: string,
    text: string,
    sender: string,
    customRef?: string,
  ): Promise<void> {
    const res = await fetch("https://api.mobilemessage.com.au/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: basicAuth(this.username, this.password),
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify({
        messages: [
          {
            to,
            message: text,
            sender,
            // The reply webhook returns this as original_custom_ref, which
            // is how a reply is matched to its message, business and customer.
            ...(customRef ? { custom_ref: customRef } : {}),
          },
        ],
      }),
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
  businessId: string,
  sender?: string,
  messageId?: string,
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
  if (mode === "android_gateway") {
    const cfg = await gatewayConfig(env, businessId);
    if (!cfg) throw new Error("android_gateway has no connected phone");
    const client = new RealSmsGateClient(
      cfg.baseUrl,
      cfg.username,
      cfg.password,
      cfg.deviceId,
    );
    await client.send(to, text);
    return;
  }
  if (mode === "sms_provider") {
    const client = new MobileMessageClient(
      env.MOBILE_MESSAGE_USERNAME ?? "",
      env.MOBILE_MESSAGE_PASSWORD ?? "",
    );
    await client.send(to, text, sender || "MurSystems", messageId);
    return;
  }
  throw new Error(`${mode} live sending is not implemented yet`);
}

// ---------- cron sender ----------

async function runSender(env: Env): Promise<void> {
  // Texts that have waited more than 7 days (for example while paused at the
  // monthly allowance) are cancelled instead of being sent late.
  try {
    await supabaseRpc(env, "expire_stale_queued_messages", {});
  } catch (e) {
    console.log(`[expire] ${String(e)}`);
  }
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
          p_error: "There is no phone number for this customer.",
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
          p_error: "Testing is on, so this text only goes to the test number.",
          p_retryable: false,
        });
        continue;
      }

      await sendSms(
        env,
        prep.send_mode,
        prep.mobile,
        prep.rendered_text,
        prep.business_id,
        prep.sender_number,
        msg.id,
      );
      await supabaseRpc(env, "mark_sent", {
        p_message_id: msg.id,
        p_text: prep.rendered_text,
        p_mock: isMockSend(prep.send_mode, env.SENDER_LIVE),
      });
    } catch (e) {
      console.log(`[send] ${msg.id} failed: ${String(e)}`);
      await supabaseRpc(env, "mark_failed", {
        p_message_id: msg.id,
        p_error: ownerFailureReason(e),
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

  let event: Record<string, unknown>;
  try {
    event = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  const { type, deviceId, fromMobile, body } = parseWebhookEvent(event);

  if (type === "system:ping" || type === "system:device_start") {
    await supabaseRpc(env, "touch_gateway", { p_device_id: deviceId });
    return new Response("ok");
  }

  if (type === "sms:received") {
    await supabaseRpc(env, "handle_inbound_sms", {
      p_device_id: deviceId,
      p_from_mobile: fromMobile,
      p_body: body,
    });
    return new Response("ok");
  }

  return new Response("ignored");
}

// ---------- Mobile Message inbound replies ----------

// The webhook is authenticated either by Mobile Message's signing secret or,
// until that is generated in their dashboard, by a secret in the configured
// webhook URL. Returns null when neither is configured (fail closed).
async function mobileMessageAuthorised(
  request: Request,
  env: Env,
  rawBody: string,
): Promise<boolean | null> {
  const signingSecret = env.MOBILE_MESSAGE_WEBHOOK_SECRET?.trim();
  if (signingSecret) {
    return verifyMobileMessageSignature(
      rawBody,
      request.headers.get("x-mm-timestamp") ?? "",
      request.headers.get("x-mm-signature") ?? "",
      signingSecret,
    );
  }
  const urlKey = env.MOBILE_MESSAGE_INBOUND_KEY?.trim();
  if (!urlKey) return null;
  const supplied = new URL(request.url).searchParams.get("key") ?? "";
  return constantTimeEqual(supplied, urlKey);
}

// POST /webhook/mobile-message — a reply or unsubscribe from a customer.
// The database matches the reply to its message/business/customer, stores it,
// and records STOP-like replies as opt-outs. Provider retries replay the same
// received_at, which the replies table dedupes.
async function handleMobileMessageWebhook(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const rawBody = await request.text();
  const authorised = await mobileMessageAuthorised(request, env, rawBody);
  if (authorised === null) {
    console.log("[mm-webhook] no signing secret or URL key configured");
    return new Response("Webhook not configured", { status: 503 });
  }
  if (!authorised) return new Response("Unauthorized", { status: 401 });

  let event: Record<string, unknown>;
  try {
    event = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  const inbound = parseMobileMessageInbound(event);
  if (!inbound.sender || !inbound.message) return new Response("ok");

  try {
    const rows = await supabaseRpc(env, "handle_sms_reply", {
      p_to_number: inbound.to || null,
      p_from_mobile: inbound.sender,
      p_body: inbound.message,
      p_is_unsubscribe: inbound.type === "unsubscribe",
      p_custom_ref: inbound.originalCustomRef || null,
      p_received_at: inbound.receivedAt || null,
    });
    const result = Array.isArray(rows) ? rows[0] : rows;
    if (!result?.matched) {
      console.log(
        `[mm-webhook] no business matched reply from ${inbound.sender} to ${inbound.to || "unknown"}`,
      );
    }
    return new Response("ok");
  } catch (e) {
    // A 5xx makes Mobile Message retry, so a database hiccup does not lose
    // the reply.
    console.log(`[mm-webhook] failed: ${String(e)}`);
    return new Response("Server error", { status: 500 });
  }
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
      const reviewCount =
        body.review_count === undefined ||
        body.review_count === null ||
        body.review_count === ""
          ? null
          : Number(body.review_count);
      if (
        reviewCount !== null &&
        (!Number.isInteger(reviewCount) || reviewCount < 0)
      ) {
        return Response.json(
          { error: "Review count must be zero or more." },
          { status: 400 },
        );
      }
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
        p_send_mode: body.send_mode ?? "android_gateway",
        p_delay_minutes: body.delay_minutes ?? 60,
        p_owner_id: ownerId,
        p_admin_id: userId,
        p_review_count: reviewCount,
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
    if (
      path.startsWith("/admin/businesses/") &&
      path.endsWith("/monthly-cap") &&
      method === "POST"
    ) {
      const id = path.split("/")[3];
      const body = (await request.json()) as Record<string, any>;
      const cap = Number(body.monthly_text_cap);
      if (!Number.isInteger(cap) || cap < 0) {
        return Response.json({ error: "Allowance must be zero or more." }, { status: 400 });
      }
      await supabaseRpc(env, "admin_set_monthly_cap", {
        p_business_id: id,
        p_cap: cap,
        p_admin_id: userId,
      });
      return Response.json({ ok: true });
    }
    if (
      path.startsWith("/admin/businesses/") &&
      path.endsWith("/billing-anchor") &&
      method === "POST"
    ) {
      const id = path.split("/")[3];
      const body = (await request.json()) as Record<string, any>;
      const anchor = String(body.billing_anchor ?? "").trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(anchor)) {
        return Response.json(
          { error: "Choose a billing date." },
          { status: 400 },
        );
      }
      await supabaseRpc(env, "admin_set_billing_anchor", {
        p_business_id: id,
        p_anchor: anchor,
        p_admin_id: userId,
      });
      return Response.json({ ok: true });
    }
    if (
      path.startsWith("/admin/businesses/") &&
      path.endsWith("/review-count") &&
      method === "POST"
    ) {
      const id = path.split("/")[3];
      const body = (await request.json()) as Record<string, any>;
      const count = Number(body.review_count);
      if (!Number.isInteger(count) || count < 0) {
        return Response.json(
          { error: "Review count must be zero or more." },
          { status: 400 },
        );
      }

      const rawDate =
        body.snapshot_date === undefined ||
        body.snapshot_date === null ||
        body.snapshot_date === ""
          ? null
          : String(body.snapshot_date);
      if (rawDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
        return Response.json(
          { error: "Choose a valid date for the review count." },
          { status: 400 },
        );
      }

      let rating: number | null = null;
      if (
        body.rating !== undefined &&
        body.rating !== null &&
        body.rating !== ""
      ) {
        rating = Number(body.rating);
        if (!Number.isFinite(rating) || rating < 0 || rating > 5) {
          return Response.json(
            { error: "Rating must be between 0 and 5." },
            { status: 400 },
          );
        }
      }

      await supabaseRpc(env, "admin_record_review_snapshot", {
        p_business_id: id,
        p_review_count: count,
        p_snapshot_date: rawDate,
        p_rating: rating,
        p_admin_id: userId,
      });
      return Response.json({ ok: true });
    }
    if (
      path.startsWith("/admin/businesses/") &&
      path.endsWith("/send-test-now") &&
      method === "POST"
    ) {
      const id = path.split("/")[3];
      const allowlist = (env.SEND_ALLOWLIST ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (allowlist.length === 0) {
        return Response.json(
          { error: "No allowlisted test number is configured." },
          { status: 400 },
        );
      }

      const body = (await request.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      const requested =
        typeof body.mobile === "string" && body.mobile.trim()
          ? body.mobile
          : allowlist[0];
      const mobile = normaliseAuMobile(requested);
      if (!mobile || !isAllowlisted(mobile, allowlist)) {
        return Response.json(
          { error: "The test text can only go to a number on SEND_ALLOWLIST." },
          { status: 403 },
        );
      }

      const stub = env.RATE_LIMITER.get(
        env.RATE_LIMITER.idFromName(`admin-test:${userId}`),
      );
      if (!(await stub.check(5, 3600_000))) {
        return Response.json(
          { error: "Too many test texts. Wait a while and try again." },
          { status: 429 },
        );
      }

      const rows = await supabaseRpc(env, "admin_create_test_message", {
        p_business_id: id,
        p_mobile: mobile,
        p_admin_id: userId,
      });
      const created = Array.isArray(rows) ? rows[0] : rows;
      if (!created?.message_id) {
        throw new Error("test message was not created");
      }

      const prepRows = await supabaseRpc(env, "prepare_send", {
        p_message_id: created.message_id,
        p_link_domain: env.LINK_DOMAIN,
      });
      const prep = prepRows?.[0];
      if (!prep || !isAllowlisted(prep.mobile, allowlist)) {
        await supabaseRpc(env, "mark_failed", {
          p_message_id: created.message_id,
          p_error: "This number is not on the test allowlist, so the text was not sent.",
          p_retryable: false,
        });
        return Response.json(
          { error: "The test text can only go to a number on SEND_ALLOWLIST." },
          { status: 403 },
        );
      }

      // Test sends still respect the global live switch. mark_sent always
      // records mock=true so a test never counts in usage or stats.
      const live = prep.send_mode !== "log_only" && env.SENDER_LIVE === "true";
      try {
        await sendSms(
          env,
          prep.send_mode,
          prep.mobile,
          prep.rendered_text,
          prep.business_id,
          prep.sender_number,
          created.message_id,
        );
        await supabaseRpc(env, "mark_sent", {
          p_message_id: created.message_id,
          p_text: prep.rendered_text,
          p_mock: true,
        });
        return Response.json({
          ok: true,
          message_id: created.message_id,
          mobile: prep.mobile,
          send_mode: prep.send_mode,
          live,
          text: prep.rendered_text,
        });
      } catch (e) {
        console.log(`[admin-test] send failed for ${id}: ${String(e)}`);
        await supabaseRpc(env, "mark_failed", {
          p_message_id: created.message_id,
          p_error: ownerFailureReason(e),
          p_retryable: true,
        });
        return Response.json(
          { error: sendFailureReason(e) },
          { status: 502 },
        );
      }
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
    if (path === "/admin/places-usage" && method === "GET") {
      const rows = await supabaseRpc(env, "admin_places_usage", {});
      return Response.json({ rows: rows ?? [], cap: MONTHLY_PLACES_CAP });
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
          `replies?business_id=eq.${id}&select=id,from_mobile,body,received_at,customer_id,customers(first_name)&order=received_at.desc&limit=50`,
        ),
      ]);
      return Response.json({ messages, replies });
    }
    return new Response("Not found", { status: 404 });
  } catch (e) {
    console.log(`[admin] ${method} ${path} failed: ${String(e)}`);
    const badRequest = e instanceof SyntaxError;
    return Response.json(
      {
        error: badRequest
          ? "That request was not valid."
          : adminFailureReason(e),
      },
      { status: badRequest ? 400 : 500 },
    );
  }
}

// ---------- owner gateway routes ----------

async function verifyUser(
  request: Request,
  env: Env,
): Promise<{ userId: string } | null> {
  const jwt = (request.headers.get("authorization") ?? "").replace(
    /^Bearer\s+/i,
    "",
  );
  const userId = await verifyUserJwt(jwt, env.SUPABASE_URL, env.SUPABASE_ANON_KEY);
  return userId ? { userId } : null;
}

// POST /gateway/test — send one text through the owner's connected phone.
// The destination must be allowlisted while PRODUCTION is unset, and each
// owner is limited to five tests an hour.
async function handleGateway(
  request: Request,
  env: Env,
  userId: string,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== "/gateway/test" || request.method !== "POST") {
    return new Response("Not found", { status: 404 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }

  const businessId = String(body.business_id ?? "");
  const mobile = normaliseAuMobile(String(body.mobile ?? ""));
  if (!businessId) {
    return Response.json({ error: "missing_business" }, { status: 400 });
  }
  if (!mobile) {
    return Response.json({ error: "invalid_mobile" }, { status: 400 });
  }

  const allowlist = (env.SEND_ALLOWLIST ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!isAllowed("android_gateway", mobile, env.PRODUCTION ?? "", allowlist)) {
    return Response.json({ error: "not_allowlisted" }, { status: 403 });
  }

  const stub = env.RATE_LIMITER.get(
    env.RATE_LIMITER.idFromName(`gateway-test:${userId}`),
  );
  if (!(await stub.check(5, 3600_000))) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }

  const rows = await supabaseRpc(env, "owner_gateway_config", {
    p_business_id: businessId,
    p_user_id: userId,
  });
  const cfg = Array.isArray(rows) ? rows[0] : rows;
  if (!cfg?.username || !cfg?.password) {
    return Response.json({ error: "not_connected" }, { status: 400 });
  }

  try {
    const client = new RealSmsGateClient(
      cfg.base_url || "https://api.sms-gate.app",
      cfg.username,
      cfg.password,
      cfg.device_id || undefined,
    );
    await client.send(
      mobile,
      "Mur Reviews test: your phone is connected and ready to send.",
    );
    return Response.json({ ok: true });
  } catch (e) {
    console.log(`[gateway-test] failed for ${businessId}: ${e}`);
    return Response.json({ error: "send_failed" }, { status: 502 });
  }
}

// ---------- review snapshots (Places API New) ----------

const MONTHLY_PLACES_CAP = 900; // Place Details Enterprise has 1,000 free/month

// Review tracking is optional: without a Places key the dashboard reports it
// as not connected and the snapshot cron exits without recording a failure.
function placesConfigured(env: Env): boolean {
  return Boolean(env.GOOGLE_PLACES_API_KEY?.trim());
}

async function fetchPlaceRating(
  env: Env,
  placeId: string,
): Promise<{ rating: number; count: number }> {
  const res = await fetch(
    `https://places.googleapis.com/v1/places/${placeId}`,
    {
      method: "GET",
      headers: {
        "X-Goog-Api-Key": env.GOOGLE_PLACES_API_KEY ?? "",
        "X-Goog-FieldMask": "rating,userRatingCount",
      },
    },
  );
  if (!res.ok) throw new Error(`Places API failed: ${res.status}`);
  const data = (await res.json()) as { rating?: number; userRatingCount?: number };
  return { rating: data.rating ?? 0, count: data.userRatingCount ?? 0 };
}

async function runSnapshots(env: Env): Promise<void> {
  if (!placesConfigured(env)) {
    console.log("[snapshots] skipped: GOOGLE_PLACES_API_KEY is not set");
    return;
  }

  const month = new Date().toISOString().slice(0, 7);
  const usage = await supabaseRpc(env, "admin_places_usage", {});
  const used =
    (Array.isArray(usage)
      ? usage.find((u: any) => u.month === month)?.request_count
      : 0) ?? 0;
  const remaining = MONTHLY_PLACES_CAP - used;
  if (remaining <= 0) {
    console.log(`[snapshots] monthly cap reached (${used}/${MONTHLY_PLACES_CAP})`);
    return;
  }

  const active = await supabaseGet(
    env,
    "businesses?status=eq.active&select=id,place_id",
  );
  if (!Array.isArray(active) || active.length === 0) return;

  // If daily snapshots would exceed the cap, snap each business less often.
  const intervalDays = Math.max(1, Math.ceil((active.length * 30) / MONTHLY_PLACES_CAP));

  let done = 0;
  for (const b of active) {
    if (done >= remaining) break;
    const last = await supabaseGet(
      env,
      `review_snapshots?business_id=eq.${b.id}&select=snapshot_date&order=snapshot_date.desc&limit=1`,
    );
    const lastDate = Array.isArray(last) ? last[0]?.snapshot_date : null;
    if (lastDate && (Date.now() - new Date(lastDate).getTime()) / 86400000 < intervalDays) {
      continue;
    }
    try {
      const place = await fetchPlaceRating(env, b.place_id);
      await supabaseRpc(env, "record_review_snapshot", {
        p_business_id: b.id,
        p_rating: place.rating,
        p_review_count: place.count,
      });
      done++;
    } catch (e) {
      console.error(`[snapshots] ${b.id} failed: ${e}`);
    }
  }
  console.log(`[snapshots] recorded ${done} (${used + done}/${MONTHLY_PLACES_CAP})`);
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

    if (path === "/webhook/mobile-message") {
      return handleMobileMessageWebhook(request, env);
    }

    if (path === "/status") {
      return withCors(
        Response.json({
          places_connected: placesConfigured(env),
          sender_live: env.SENDER_LIVE === "true",
        }),
        allowOrigin,
      );
    }

    if (path.startsWith("/admin/")) {
      const admin = await verifyAdmin(request, env);
      if (!admin) {
        return withCors(new Response("Unauthorized", { status: 401 }), allowOrigin);
      }
      return withCors(await handleAdmin(request, env, admin.userId), allowOrigin);
    }

    if (path.startsWith("/gateway/")) {
      const user = await verifyUser(request, env);
      if (!user) {
        return withCors(new Response("Unauthorized", { status: 401 }), allowOrigin);
      }
      return withCors(
        await handleGateway(request, env, user.userId),
        allowOrigin,
      );
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

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    if (controller.cron === "0 1 * * *") {
      await runSnapshots(env);
    } else {
      await runSender(env);
    }
  },
};
