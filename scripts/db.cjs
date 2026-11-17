#!/usr/bin/env node
'use strict';

// Small, reusable connection helper for operator scripts. Reads the linked
// project's pooler URL from supabase/.temp/ and the password from .env — the
// password is never printed.
//
// Usage:
//   node scripts/db.cjs "select ..."                 # read-only
//   node scripts/db.cjs --confirm "update ..."       # write
//   node scripts/db.cjs --file path.sql --confirm

const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function readEnvValue(name) {
  const file = path.join(ROOT, '.env');
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
  const match = text.match(new RegExp('^' + name + '=(.*)$', 'm'));
  if (!match) return '';
  return match[1].replace(/\r$/, '').replace(/^["']|["']$/g, '').trim();
}

function readTrim(p) {
  try {
    return fs.readFileSync(p, 'utf8').trim();
  } catch {
    return '';
  }
}

function connectOptions() {
  const poolerUrl = readTrim(path.join(ROOT, 'supabase', '.temp', 'pooler-url'));
  const password = readEnvValue('SUPABASE_DB_PASSWORD');
  if (!password) throw new Error('SUPABASE_DB_PASSWORD not found in .env');
  if (!poolerUrl) throw new Error('supabase/.temp/pooler-url missing — run `supabase link` first');

  const u = new URL(poolerUrl);
  return {
    host: u.hostname,
    port: Number(u.port || 5432),
    user: u.username,
    password,
    database: 'postgres',
    ssl: { rejectUnauthorized: false },
  };
}

async function query(sql, params) {
  const client = new Client(connectOptions());
  await client.connect();
  try {
    const result = await client.query(sql, params);
    return result.rows;
  } finally {
    await client.end().catch(() => {});
  }
}

async function main() {
  const args = process.argv.slice(2);
  const confirm = args.includes('--confirm');
  const fileIdx = args.indexOf('--file');
  const sql =
    fileIdx >= 0
      ? fs.readFileSync(path.resolve(ROOT, args[fileIdx + 1]), 'utf8')
      : args.filter((a) => !a.startsWith('--')).join(' ');

  if (!sql) {
    console.error('Usage: node scripts/db.cjs [--confirm] "<sql>" | --file <path.sql>');
    process.exit(2);
  }

  const isWrite = !/^\s*(select|show|explain|with)\b/i.test(sql);
  if (isWrite && !confirm) {
    console.error('Refusing to run a write without --confirm.');
    process.exit(1);
  }

  const rows = await query(sql);
  console.log(JSON.stringify(rows, null, 2));
}

module.exports = { ROOT, readEnvValue, connectOptions, query };

if (require.main === module) {
  main().catch((e) => {
    console.error('DB error: ' + e.message);
    process.exit(1);
  });
}
