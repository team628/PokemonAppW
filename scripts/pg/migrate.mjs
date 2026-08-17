/**
 * Applies supabase/migrations/*.sql in order.
 *
 * Every migration is written to be idempotent, so this is safe to re-run; it is
 * how a fresh development database is built and how the local test database
 * stays in step with what would be deployed. In production the same files are
 * applied by `supabase db push`.
 *
 *   node scripts/pg/migrate.mjs [connection-string]
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

const url =
  process.argv[2] ??
  process.env.SUPABASE_DB_URL ??
  process.env.DATABASE_URL ??
  'postgresql://postgres@127.0.0.1:5432/postgres';

const dir = path.join(process.cwd(), 'supabase', 'migrations');
const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

const client = new pg.Client({ connectionString: url });
await client.connect();

try {
  for (const f of files) {
    const sql = await readFile(path.join(dir, f), 'utf8');
    process.stdout.write(`applying ${f} … `);
    await client.query(sql);
    console.log('ok');
  }
  console.log(`\n${files.length} migrations applied to ${url.replace(/:[^:@/]*@/, ':***@')}`);
} catch (e) {
  console.error(`\nfailed: ${e.message}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
