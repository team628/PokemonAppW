/**
 * Bundle and deploy the Supabase Edge Functions over the Management API.
 *
 *   SUPABASE_ACCESS_TOKEN=… SUPABASE_PROJECT_REF=… node scripts/deploy/deploy-functions.mjs
 *
 * Why not `supabase functions deploy`: the CLI's HTTP client does not honour
 * this environment's egress proxy and hangs. The Management API does work over
 * the proxy, so each function is bundled locally with esbuild — which resolves
 * the extensionless relative imports between the shared src/ modules that the
 * server-side bundler could not — and the single self-contained file is posted
 * to the deploy endpoint. `postgres` and node: builtins are left external; the
 * edge runtime provides both, and deno.json maps `postgres` to npm:postgres.
 *
 * The functions are deployed with the gateway's JWT verification on; each one
 * additionally checks the caller is the service role (see _shared/db.ts).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const REF = process.env.SUPABASE_PROJECT_REF;
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
if (!REF || !TOKEN) throw new Error('SUPABASE_PROJECT_REF and SUPABASE_ACCESS_TOKEN must be set');

const FUNCTIONS = ['price-sync', 'catalog-sync'];
const work = mkdtempSync(path.join(tmpdir(), 'setvalue-fn-'));

for (const slug of FUNCTIONS) {
  const entry = `supabase/functions/${slug}/index.ts`;
  const out = path.join(work, `${slug}.js`);
  process.stdout.write(`bundling ${slug} … `);
  execFileSync(
    'npx',
    [
      'esbuild', entry, '--bundle', '--format=esm', '--platform=neutral',
      '--target=deno1', '--packages=external', `--outfile=${out}`,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );
  const bytes = readFileSync(out).length;
  process.stdout.write(`${(bytes / 1024).toFixed(1)}kb, deploying … `);

  const metadata = JSON.stringify({
    name: slug,
    entrypoint_path: 'index.js',
    import_map_path: 'deno.json',
    verify_jwt: true,
  });
  const res = execFileSync(
    'curl',
    [
      '-s', '--max-time', '180', '-X', 'POST',
      `https://api.supabase.com/v1/projects/${REF}/functions/deploy?slug=${slug}`,
      '-H', `Authorization: Bearer ${TOKEN}`,
      '-F', `metadata=${metadata};type=application/json`,
      '-F', `file=@${out};filename=index.js;type=application/javascript`,
      '-F', `file=@supabase/functions/deno.json;filename=deno.json;type=application/json`,
    ],
    { encoding: 'utf8' },
  );
  const body = JSON.parse(res);
  if (body.status !== 'ACTIVE') throw new Error(`deploy failed for ${slug}: ${res}`);
  console.log(`v${body.version} ${body.status}`);
}
console.log('\nboth functions deployed');
