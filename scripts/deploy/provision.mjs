/**
 * Provisions a Supabase project for SetValue, end to end.
 *
 *   SUPABASE_ACCESS_TOKEN=sbp_... node scripts/deploy/provision.mjs [--name setvalue] [--region us-east-1]
 *
 * Creates the project, waits for it, fetches its keys, and writes them to a
 * file outside the repository. Nothing is printed: the whole point is that the
 * service-role key and the database password exist on disk with 0600 and
 * nowhere else.
 *
 * Idempotent by name. Re-running against an existing project adopts it rather
 * than creating a second one, so a half-finished provision can be resumed.
 *
 * This does not apply migrations, ingest, or deploy functions — those are
 * separate steps with their own failure modes, and the safety gate sits between
 * them. See scripts/deploy/README.md.
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

const API = 'https://api.supabase.com/v1';
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
if (!TOKEN) {
  console.error(
    'SUPABASE_ACCESS_TOKEN is not set.\n' +
      'Create one at https://supabase.com/dashboard/account/tokens and export it.',
  );
  process.exit(1);
}

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const NAME = arg('--name', 'setvalue');
const REGION = arg('--region', 'us-east-1');
const OUT = arg('--out', path.join(process.env.HOME ?? '/tmp', '.setvalue-deploy'));

async function api(pathname, init = {}) {
  const res = await fetch(API + pathname, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const message = typeof body === 'object' && body?.message ? body.message : String(body);
    throw new Error(`${init.method ?? 'GET'} ${pathname} -> ${res.status}: ${message}`);
  }
  return body;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  mkdirSync(OUT, { recursive: true, mode: 0o700 });
  const envPath = path.join(OUT, 'project.env');

  // ------------------------------------------------------------ organisation
  const orgs = await api('/organizations');
  if (!orgs.length) throw new Error('this account has no organisation');
  const org = orgs[0];
  console.log(`organisation: ${org.name} (${orgs.length} available, using the first)`);

  // -------------------------------------------------------------- the project
  const projects = await api('/projects');
  let project = projects.find((p) => p.name === NAME);
  let dbPassword;

  if (project) {
    console.log(`adopting existing project ${project.id} (${project.region}, ${project.status})`);
    // The password is only ever returned at creation, so a resumed run needs
    // the one from the first run.
    if (existsSync(envPath)) {
      dbPassword = readFileSync(envPath, 'utf8').match(/^SUPABASE_DB_PASSWORD=(.*)$/m)?.[1];
    }
    if (!dbPassword) {
      throw new Error(
        `project "${NAME}" already exists but its password is not in ${envPath}. ` +
          'Reset it in the dashboard (Settings -> Database) and put it there, or use --name.',
      );
    }
  } else {
    // Generated here so it is strong and so it never passes through a chat
    // transcript. It lands in ${envPath} with 0600 and nowhere else.
    dbPassword = randomBytes(24).toString('base64url');
    console.log(`creating project "${NAME}" in ${REGION}…`);
    project = await api('/projects', {
      method: 'POST',
      body: JSON.stringify({
        name: NAME,
        organization_id: org.id,
        region: REGION,
        db_pass: dbPassword,
      }),
    });
    console.log(`created ${project.id}`);
  }

  const ref = project.id;

  // ------------------------------------------------------------ wait for it
  process.stdout.write('waiting for the project to come up');
  for (let i = 0; i < 60; i++) {
    const p = await api(`/projects/${ref}`).catch(() => null);
    if (p?.status === 'ACTIVE_HEALTHY') {
      console.log(' — healthy');
      break;
    }
    process.stdout.write('.');
    await sleep(10_000);
    if (i === 59) throw new Error(`project never became healthy (last status ${p?.status})`);
  }

  // ------------------------------------------------------------------- keys
  const keys = await api(`/projects/${ref}/api-keys?reveal=true`);
  const anon = keys.find((k) => k.name === 'anon' || k.type === 'anon')?.api_key;
  const service = keys.find((k) => k.name === 'service_role' || k.type === 'service_role')?.api_key;
  if (!anon || !service) throw new Error('could not read the project API keys');

  // The pooler host is reported rather than guessed: the naming has changed
  // between generations of Supavisor and a wrong host is a confusing failure.
  const pooler = await api(`/projects/${ref}/config/database/pooler`).catch(() => null);
  const poolerUrl =
    (Array.isArray(pooler) ? pooler.find((p) => p.database_type === 'PRIMARY') : pooler)
      ?.connection_string ?? null;

  const dbUrl = poolerUrl
    ? poolerUrl.replace(/\[YOUR-PASSWORD\]|\bpassword\b/i, dbPassword)
    : `postgresql://postgres.${ref}:${dbPassword}@aws-0-${REGION}.pooler.supabase.com:6543/postgres`;

  writeFileSync(
    envPath,
    [
      '# Written by scripts/deploy/provision.mjs. Secrets: 0600, never committed.',
      `SUPABASE_PROJECT_REF=${ref}`,
      `SUPABASE_REGION=${project.region}`,
      `NEXT_PUBLIC_SUPABASE_URL=https://${ref}.supabase.co`,
      `NEXT_PUBLIC_SUPABASE_ANON_KEY=${anon}`,
      `SUPABASE_SERVICE_ROLE_KEY=${service}`,
      `SUPABASE_DB_PASSWORD=${dbPassword}`,
      `SUPABASE_DB_URL=${dbUrl}`,
      'CARD_DATA_PROVIDER=pokemontcg',
      '',
    ].join('\n'),
    { mode: 0o600 },
  );

  console.log(`\nproject ref: ${ref}`);
  console.log(`region:      ${project.region}`);
  console.log(`api url:     https://${ref}.supabase.co`);
  console.log(`pooler host: ${new URL(dbUrl.replace('postgresql://', 'https://')).hostname}`);
  console.log(`credentials: ${envPath} (0600)`);
  console.log(
    poolerUrl ? '' : '\nnote: the pooler endpoint was not reported; the URL above is constructed.',
  );
}

main().catch((e) => {
  console.error(`\nfailed: ${e.message}`);
  process.exit(1);
});
