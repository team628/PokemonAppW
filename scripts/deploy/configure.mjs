/**
 * Configures a provisioned Supabase project: Auth, Vault, and the schedule.
 *
 *   node scripts/deploy/configure.mjs --site-url https://<preview>.vercel.app
 *
 * Reads the credentials provision.mjs wrote. Prints nothing secret.
 *
 * Run this after migrations and the safety gate have passed — the schedule
 * registers jobs that write to the database, and there is no reason to have
 * them firing at a schema that has not been verified.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const OUT = path.join(process.env.HOME ?? '/tmp', '.setvalue-deploy');
const envPath = path.join(OUT, 'project.env');
if (!existsSync(envPath)) {
  console.error(`no credentials at ${envPath} — run scripts/deploy/provision.mjs first`);
  process.exit(1);
}
const env = Object.fromEntries(
  readFileSync(envPath, 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);

const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
if (!TOKEN) {
  console.error('SUPABASE_ACCESS_TOKEN is not set');
  process.exit(1);
}
const REF = env.SUPABASE_PROJECT_REF;
const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const SITE_URL = arg('--site-url', null);

async function api(pathname, init = {}) {
  const res = await fetch(`https://api.supabase.com/v1${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  const body = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null;
  if (!res.ok) {
    throw new Error(`${init.method ?? 'GET'} ${pathname} -> ${res.status}: ${body?.message ?? body}`);
  }
  return body;
}

async function main() {
  if (!SITE_URL) {
    console.error('--site-url is required: Auth needs to know where to send people back to.');
    process.exit(1);
  }
  const origin = new URL(SITE_URL).origin;

  // --------------------------------------------------------------- Auth
  //
  // Email confirmation stays ON. A private beta is exactly where you want to
  // know an address is real before an account exists at it, and turning it off
  // to make a smoke test easier is the kind of shortcut that ships.
  console.log('configuring Auth…');
  await api(`/projects/${REF}/config/auth`, {
    method: 'PATCH',
    body: JSON.stringify({
      site_url: origin,
      uri_allow_list: [`${origin}/auth/callback`, `${origin}/**`].join(','),
      external_email_enabled: true,
      mailer_autoconfirm: false,
      // The application applies its own per-address and per-account limits in
      // the database; these are the provider's backstop.
      rate_limit_email_sent: 30,
      password_min_length: 8,
      jwt_exp: 3600,
      refresh_token_rotation_enabled: true,
      security_refresh_token_reuse_interval: 10,
    }),
  });

  const auth = await api(`/projects/${REF}/config/auth`);
  console.log(`  site url:            ${auth.site_url}`);
  console.log(`  redirect allow list: ${auth.uri_allow_list}`);
  console.log(`  email confirmation:  ${auth.mailer_autoconfirm ? 'OFF' : 'ON'}`);
  console.log(`  refresh rotation:    ${auth.refresh_token_rotation_enabled ? 'on' : 'off'}`);
  console.log(`  access token ttl:    ${auth.jwt_exp}s`);
}

main().catch((e) => {
  console.error(`\nfailed: ${e.message}`);
  process.exit(1);
});
