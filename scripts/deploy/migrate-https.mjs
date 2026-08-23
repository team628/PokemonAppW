/**
 * Apply supabase/migrations/*.sql over the HTTPS query endpoint.
 *
 * The pg-socket migrate.mjs cannot reach a hosted project from this container
 * (raw-TCP is proxy-blocked), so this posts each migration's full text to the
 * Management query endpoint — one file, one implicit transaction, in order.
 * Migrations are idempotent, so a second pass is the proof, exactly as CI runs
 * it twice.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { query } from './https-sql.mjs';

const dir = path.join(process.cwd(), 'supabase', 'migrations');
const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

for (const f of files) {
  const sql = await readFile(path.join(dir, f), 'utf8');
  process.stdout.write(`applying ${f} … `);
  try {
    await query(sql);
    console.log('ok');
  } catch (e) {
    console.error(`\nFAILED on ${f}:\n${e.message}`);
    process.exit(1);
  }
}
console.log(`\n${files.length} migrations applied`);
