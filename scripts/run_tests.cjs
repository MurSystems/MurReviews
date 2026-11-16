#!/usr/bin/env node
'use strict';

// Runs the pgTAP test files in supabase/tests/ against the linked Supabase
// project — without Docker. Each file runs inside its own transaction that is
// ALWAYS rolled back, so no test data ever persists.
//
// Usage:
//   npm run test:db                 # prints the target and refuses to run
//   npm run test:db -- --confirm    # actually runs the tests
//
// Prereqs: `supabase link` has been run (writes supabase/.temp/project-ref
// and pooler-url), and SUPABASE_DB_PASSWORD is set in .env.

const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function readTrim(p) {
  try {
    return fs.readFileSync(p, 'utf8').trim();
  } catch {
    return '';
  }
}

// ---- config ----
const projectRef = readTrim(path.join(ROOT, 'supabase', '.temp', 'project-ref'));
const poolerUrl = readTrim(path.join(ROOT, 'supabase', '.temp', 'pooler-url'));
const envText = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
const pwMatch = envText.match(/^SUPABASE_DB_PASSWORD=(.*)$/m);
if (!pwMatch) {
  console.error('ERROR: SUPABASE_DB_PASSWORD not found in .env');
  process.exit(2);
}
const password = pwMatch[1].replace(/\r$/, '');

let host, port, user;
try {
  const u = new URL(poolerUrl); // postgresql://postgres.<ref>@host:port/postgres
  host = u.hostname;
  port = Number(u.port || 5432);
  user = u.username;
} catch {
  console.error('ERROR: could not parse supabase/.temp/pooler-url — run `supabase link` first.');
  process.exit(2);
}

const testsDir = path.join(ROOT, 'supabase', 'tests');
const files = fs.readdirSync(testsDir).filter((f) => f.endsWith('.sql')).sort();

// ---- guard: print target, require explicit confirmation ----
console.log('About to run pgTAP tests against:');
console.log(`  project ref : ${projectRef}`);
console.log(`  pooler host : ${host}:${port} (session mode)`);
console.log(`  test files  : ${files.length} in supabase/tests/`);
if (!process.argv.includes('--confirm')) {
  console.error('\nRefusing to run without confirmation.');
  console.error('Re-run with: npm run test:db -- --confirm');
  process.exit(1);
}

let failed = 0;

(async () => {
  for (const f of files) {
    const client = new Client({
      host,
      port,
      user,
      password,
      database: 'postgres',
      ssl: { rejectUnauthorized: false },
    });
    const notices = [];
    client.on('notice', (n) => notices.push(n.message));

    console.log('\n===== ' + f + ' =====');
    let notOk = 0;
    let errored = false;

    try {
      await client.connect();
      await client.query('set search_path = extensions, public');
      await client.query('create extension if not exists pgtap with schema extensions');
      await client.query('BEGIN');
      const sql = fs.readFileSync(path.join(testsDir, f), 'utf8');
      const results = await client.query(sql);
      const arr = Array.isArray(results) ? results : [results];
      for (const r of arr) {
        if (r && r.rows) {
          for (const row of r.rows) {
            for (const v of Object.values(row)) {
              if (typeof v === 'string' && v.trim() !== '') {
                const line = v.trim();
                console.log(line);
                if (/^not ok\b/.test(line)) notOk++;
              }
            }
          }
        }
      }
      for (const n of notices) console.log('# ' + n);
      await client.query('ROLLBACK');
    } catch (e) {
      errored = true;
      console.error('ERROR: ' + e.message);
      for (const n of notices) console.log('# ' + n);
      await client.query('ROLLBACK').catch(() => {});
    }

    if (notOk > 0 || errored) failed++;
    await client.end().catch(() => {});
  }

  console.log('\n========================================');
  console.log(failed === 0 ? 'ALL TESTS PASSED' : `FAILED: ${failed} test file(s)`);
  process.exit(failed === 0 ? 0 : 1);
})();
