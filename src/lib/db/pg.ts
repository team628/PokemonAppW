import { Pool, types, type PoolClient } from 'pg';

/**
 * PostgreSQL access, with Row Level Security as the authorization boundary.
 *
 * Every user-scoped query runs on a connection that has been switched to the
 * `authenticated` role with the caller's verified Supabase JWT claims applied,
 * exactly as PostgREST does. The consequence is that the RLS policies decide
 * what is visible — application code cannot forget a `where user_id = ...` and
 * leak another collector's shelf, because the database would not return the
 * rows even if it did.
 *
 * `SET LOCAL` scopes both the role and the claims to the surrounding
 * transaction, so a pooled connection can never carry one collector's identity
 * into the next request that borrows it.
 *
 * On Vercel this points at Supabase's Supavisor pooler (port 6543, transaction
 * mode), which is what makes a pool safe from a serverless function.
 */

// Return int8 as a number. All money in this product is integer cents and stays
// far inside 2^53; parsing it as a string would silently turn arithmetic into
// concatenation.
types.setTypeParser(20, (v) => Number(v));
// numeric → number, for the few aggregate results that come back as numeric.
types.setTypeParser(1700, (v) => Number(v));

const connectionString =
  process.env.SUPABASE_DB_URL ??
  process.env.DATABASE_URL ??
  'postgresql://postgres@127.0.0.1:5432/postgres';

declare global {
  // eslint-disable-next-line no-var
  var __setvalue_pool: Pool | undefined;
}

export function getPool(): Pool {
  if (!globalThis.__setvalue_pool) {
    globalThis.__setvalue_pool = new Pool({
      connectionString,
      // Serverless invocations are short-lived and many; a small per-instance
      // pool against a transaction-mode pooler is the right shape.
      max: Number(process.env.PG_POOL_MAX ?? 8),
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
      ssl: connectionString.includes('127.0.0.1') || connectionString.includes('localhost')
        ? undefined
        : { rejectUnauthorized: true },
    });
    globalThis.__setvalue_pool.on('error', (err) => {
      console.error('[pg] idle client error:', err.message);
    });
  }
  return globalThis.__setvalue_pool;
}

export interface QueryResult<T> {
  rows: T[];
}

type Params = readonly unknown[];

/**
 * Runs work inside a transaction as the given identity.
 *
 * `userId === null` means the anonymous role — used by the landing page, the
 * partner console and public share pages. Those still go through RLS; `anon`
 * simply has different policies.
 */
export async function withIdentity<T>(
  userId: string | null,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('begin');
    if (userId) {
      await client.query("select set_config('role', 'authenticated', true)");
      await client.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: userId, role: 'authenticated' }),
      ]);
    } else {
      await client.query("select set_config('role', 'anon', true)");
      await client.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ role: 'anon' }),
      ]);
    }
    const out = await fn(new Tx(client));
    await client.query('commit');
    return out;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Runs work as `service_role`, which bypasses RLS.
 *
 * Reserved for background jobs (price sync, catalog reconciliation, index
 * rebuilds) and never reachable from a request handler that carries a user's
 * identity. Anything a collector can trigger goes through `withIdentity`.
 */
export async function withServiceRole<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('begin');
    await client.query("select set_config('role', 'service_role', true)");
    const out = await fn(new Tx(client));
    await client.query('commit');
    return out;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export class Tx {
  constructor(private readonly client: PoolClient) {}

  async rows<T>(sql: string, params: Params = []): Promise<T[]> {
    const res = await this.client.query(sql, params as unknown[]);
    return res.rows as T[];
  }

  async one<T>(sql: string, params: Params = []): Promise<T | undefined> {
    const rows = await this.rows<T>(sql, params);
    return rows[0];
  }

  async exec(sql: string, params: Params = []): Promise<number> {
    const res = await this.client.query(sql, params as unknown[]);
    return res.rowCount ?? 0;
  }

  /** Escape hatch for the few places that need the raw client (COPY, cursors). */
  get raw(): PoolClient {
    return this.client;
  }
}

export async function closePool(): Promise<void> {
  const pool = globalThis.__setvalue_pool;
  if (!pool) return;
  // Cleared before awaiting: two teardown hooks racing on the same pool would
  // otherwise both pass the guard and the second `end()` would throw.
  globalThis.__setvalue_pool = undefined;
  await pool.end();
}
