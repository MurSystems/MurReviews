#!/usr/bin/env node
'use strict';

// Operator helper for the SMSGate (SMS Gateway for Android) cloud account.
// Credentials are read from the root .env and never printed.
//
// Add to .env first:
//   SMSGATE_DEMO_BASE_URL=https://api.sms-gate.app
//   SMSGATE_DEMO_USERNAME=...
//   SMSGATE_DEMO_PASSWORD=...
//   SMSGATE_DEMO_DEVICE_ID=...
//
// Usage:
//   node scripts/gateway_setup.cjs check
//   node scripts/gateway_setup.cjs register
//   node scripts/gateway_setup.cjs store ["Demo Cafe" | <business-id>]
//   node scripts/gateway_setup.cjs send <mobile> ["text"]

const { readEnvValue, query } = require('./db.cjs');

const BASE = (readEnvValue('SMSGATE_DEMO_BASE_URL') || 'https://api.sms-gate.app').replace(/\/+$/, '');
const USERNAME = readEnvValue('SMSGATE_DEMO_USERNAME');
const PASSWORD = readEnvValue('SMSGATE_DEMO_PASSWORD');
const DEVICE_ID = readEnvValue('SMSGATE_DEMO_DEVICE_ID');
const WEBHOOK_URL =
  readEnvValue('SMSGATE_WEBHOOK_URL') || 'https://m.mursystems123.workers.dev/webhook';

function authHeader() {
  if (!USERNAME || !PASSWORD) {
    throw new Error('SMSGATE_DEMO_USERNAME / SMSGATE_DEMO_PASSWORD missing from .env');
  }
  return 'Basic ' + Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64');
}

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: authHeader(),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, ok: res.ok, data };
}

async function check() {
  const r = await api('GET', '/3rdparty/v1/devices');
  if (!r.ok) {
    console.log(`SMSGate check failed: HTTP ${r.status}`);
    console.log('Check the username/password in .env and that Cloud server is on.');
    process.exit(1);
  }
  const devices = Array.isArray(r.data) ? r.data : r.data?.content ?? [];
  console.log(`SMSGate reachable at ${BASE}`);
  console.log(`Devices: ${devices.length}`);
  for (const d of devices) {
    console.log(`  id=${d.id ?? d.deviceId ?? '?'} name=${d.name ?? 'unnamed'} online=${d.online ?? 'unknown'}`);
  }
  if (DEVICE_ID) {
    const match = devices.some((d) => (d.id ?? d.deviceId) === DEVICE_ID);
    console.log(`SMSGATE_DEMO_DEVICE_ID matches a listed device: ${match ? 'yes' : 'no'}`);
  }
}

async function register() {
  const existing = await api('GET', '/3rdparty/v1/webhooks');
  const current = existing.ok && Array.isArray(existing.data) ? existing.data : [];

  for (const event of ['sms:received', 'system:ping']) {
    const already = current.some((w) => w.event === event && w.url === WEBHOOK_URL);
    if (already) {
      console.log(`${event}: already registered`);
      continue;
    }
    const r = await api('POST', '/3rdparty/v1/webhooks', {
      url: WEBHOOK_URL,
      event,
      ...(DEVICE_ID ? { deviceId: DEVICE_ID } : {}),
    });
    if (r.ok) console.log(`${event}: registered (HTTP ${r.status})`);
    else {
      console.log(`${event}: failed (HTTP ${r.status})`);
      process.exitCode = 1;
    }
  }
  console.log('Webhook URL: ' + WEBHOOK_URL);
}

async function resolveBusiness(target) {
  if (target) {
    const byId = await query('select id, name from public.businesses where id = $1', [target]);
    if (byId.length) return byId[0];
    const byName = await query(
      'select id, name from public.businesses where name = $1 order by created_at limit 2',
      [target],
    );
    if (byName.length === 1) return byName[0];
    if (byName.length > 1) throw new Error(`more than one business named "${target}" — pass the id`);
    throw new Error(`no business matches "${target}"`);
  }
  const demo = await query("select id, name from public.businesses where name = 'Demo Cafe' limit 1");
  if (!demo.length) throw new Error('Demo Cafe not found — pass a business id or name');
  return demo[0];
}

async function store(target) {
  if (!USERNAME || !PASSWORD) {
    throw new Error('SMSGATE_DEMO_USERNAME / SMSGATE_DEMO_PASSWORD missing from .env');
  }
  const business = await resolveBusiness(target);
  const payload = {
    baseUrl: BASE,
    username: USERNAME,
    password: PASSWORD,
    deviceId: DEVICE_ID || null,
  };
  await query(
    `insert into public.gateway_credentials (business_id, provider, payload)
     values ($1, 'smsgate', $2::jsonb)
     on conflict (business_id, provider) do update
       set payload = excluded.payload, updated_at = now()`,
    [business.id, JSON.stringify(payload)],
  );
  console.log(`Stored SMSGate credentials for ${business.name} (${business.id}).`);
  console.log(`Device id stored: ${DEVICE_ID ? 'yes' : 'no (inbound replies need it)'}`);
}

async function send(mobile, text) {
  if (!mobile) throw new Error('Usage: send <mobile> ["text"]');
  const r = await api('POST', '/3rdparty/v1/messages', {
    textMessage: { text: text || 'Mur Reviews test text.' },
    phoneNumbers: [mobile],
    ...(DEVICE_ID ? { deviceId: DEVICE_ID } : {}),
  });
  console.log(`Send HTTP ${r.status}`);
  if (r.data && typeof r.data === 'object') {
    console.log(`id=${r.data.id ?? '?'} status=${r.data.status ?? r.data.state ?? '?'}`);
  }
  if (!r.ok) process.exitCode = 1;
}

(async () => {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'check':
      await check();
      break;
    case 'register':
      await register();
      break;
    case 'store':
      await store(rest[0]);
      break;
    case 'send':
      await send(rest[0], rest.slice(1).join(' '));
      break;
    default:
      console.error('Usage: node scripts/gateway_setup.cjs check|register|store [business]|send <mobile> [text]');
      process.exit(2);
  }
})().catch((e) => {
  console.error('Gateway setup error: ' + e.message);
  process.exit(1);
});
