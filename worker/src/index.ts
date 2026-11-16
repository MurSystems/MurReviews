import { DurableObject } from "cloudflare:workers";

export interface Env {
  RATE_LIMITER: DurableObjectNamespace<RateLimiter>;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
}

// Obvious link-preview and scanner user agents — these must never count as a
// customer click, because a false click cancels the reminder.
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
): Promise<Record<string, unknown>[]> {
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
  return (await res.json()) as Record<string, unknown>[];
}

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
  // Redirect target comes only from the business's stored place_id — never
  // from the request.
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
  // Opt-out only ever happens on POST. A GET (from a link-preview bot or a
  // carrier scanner) only shows the confirm page and never opts anyone out.
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Rate-limit by client IP: 100 requests/minute.
    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
    const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(ip));
    const allowed = await stub.check(100, 60_000);
    if (!allowed) return new Response("Too many requests", { status: 429 });

    if (path.startsWith("/r/")) return handleReview(request, env, path.slice(3));
    if (path.startsWith("/o/")) return handleOptOut(request, env, path.slice(3));
    return new Response("Not found", { status: 404 });
  },
};
