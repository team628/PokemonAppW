/**
 * SQL over Supabase's HTTPS query endpoint.
 *
 * This container's egress proxy does not carry raw-TCP database connections
 * (its own documentation lists that as unsupported), so the `pg` socket path
 * used by the scripts and the test suite cannot reach a hosted project from
 * here. Supabase's Management API exposes `POST /v1/projects/{ref}/database/query`,
 * which runs arbitrary SQL over HTTPS and returns rows as JSON — the same
 * database, reached the one way this environment allows.
 *
 * Two things it does not do that the `pg` client does:
 *
 *   - Bound parameters. The endpoint takes a SQL string only, so values are
 *     inlined here. `lit()` does the escaping: standard_conforming_strings is on
 *     by a hosted project's default, so a doubled single quote is the whole of
 *     it — no backslash games. Every caller passes provider-sourced or
 *     literal-typed values, never anything a stranger authored.
 *   - A persistent session. Each POST is its own implicit transaction, which is
 *     exactly why `set local role …; select …` in one request is a faithful RLS
 *     probe: the role is scoped to that transaction and gone at the next.
 */
import { execFileSync } from 'node:child_process';

const REF = process.env.SUPABASE_PROJECT_REF;
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
if (!REF || !TOKEN) throw new Error('SUPABASE_PROJECT_REF and SUPABASE_ACCESS_TOKEN must be set');

const ENDPOINT = `https://api.supabase.com/v1/projects/${REF}/database/query`;

/** A SQL string literal, safely inlined. */
export function lit(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return `'${String(v).replace(/'/g, "''")}'`;
}

/** Inline `$1,$2,…` placeholders with escaped literals. */
export function inline(sql, params = []) {
  if (!params.length) return sql;
  return sql.replace(/\$(\d+)/g, (_, n) => lit(params[Number(n) - 1]));
}

/**
 * Run SQL and return the rows. Uses curl through the environment's proxy rather
 * than fetch, so it inherits the proxy's CA exactly as every other HTTPS call in
 * this project does.
 */
export async function query(sql, params = []) {
  const body = JSON.stringify({ query: inline(sql, params) });
  const out = execFileSync(
    'curl',
    [
      '-s', '--max-time', '180', '-X', 'POST', ENDPOINT,
      '-H', `Authorization: Bearer ${TOKEN}`,
      '-H', 'Content-Type: application/json',
      '--data-binary', '@-',
    ],
    { input: body, maxBuffer: 256 * 1024 * 1024 },
  ).toString();
  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch {
    throw new Error(`non-JSON response: ${out.slice(0, 400)}`);
  }
  if (parsed && !Array.isArray(parsed) && parsed.message) {
    throw new Error(parsed.message);
  }
  return Array.isArray(parsed) ? parsed : [];
}

/**
 * A `SyncTx` for the ingest core, backed by the endpoint.
 *
 * `exec` cannot report an affected-row count — the endpoint returns rows, not a
 * command tag — so inserts append `returning 1` and the count is the rows back.
 * The ingest uses the number only for its log line, never for control flow.
 */
export function httpsTx() {
  const run = async (sql, params) => query(sql, params);
  return {
    async rows(sql, params = []) {
      return run(sql, params);
    },
    async one(sql, params = []) {
      return (await run(sql, params))[0] ?? null;
    },
    async exec(sql, params = []) {
      const isInsertUpdate = /^\s*(insert|update|delete)\b/i.test(sql);
      const withReturn =
        isInsertUpdate && !/\breturning\b/i.test(sql) ? `${sql.trimEnd().replace(/;?\s*$/, '')} returning 1` : sql;
      const r = await run(withReturn, params);
      return r.length;
    },
  };
}
