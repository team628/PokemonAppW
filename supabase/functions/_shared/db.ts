import postgres from 'postgres';

import type { SyncTx } from '../../../src/lib/sync/ingest.ts';

/**
 * The driver, as this module uses it.
 *
 * `postgres` types itself around a tagged-template API that none of this uses:
 * every statement here is SQL the shared ingest core already wrote, run through
 * `unsafe` with bound parameters. Describing just that surface keeps the
 * looseness at this one seam instead of letting it leak outwards — everything
 * this module exports is fully typed.
 */
interface Driver {
  unsafe(text: string, params?: unknown[]): Promise<unknown[] & { count?: number }>;
}

/**
 * A `SyncTx` backed by a Deno Postgres client.
 *
 * The ingest core does not know which runtime it is in — it asks for something
 * that can run parameterised SQL and return rows. This is that, for the Edge
 * Functions, and `pg` is that for the scripts. Neither reimplements any of the
 * logic above it.
 *
 * `prepare: false` is not optional: the connection goes through Supavisor in
 * transaction mode, where a prepared statement created on one pooled backend is
 * not there on the next. `max: 1` because a function invocation is a single
 * unit of work and a second connection buys nothing.
 */
export interface Session extends SyncTx {
  /** Runs `fn` inside one transaction, as `service_role`. */
  transaction<T>(fn: (tx: SyncTx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function connect(url: string): Session {
  const sql = postgres(url, {
    prepare: false,
    max: 1,
    idle_timeout: 20,
    connect_timeout: 15,
    // Supabase terminates TLS in front of the pooler; the certificate is the
    // project's own and is verified by default. Never turn that off.
    ssl: url.includes('localhost') || url.includes('127.0.0.1') ? false : 'require',
    onnotice: () => {},
  }) as unknown as Driver & {
    begin<T>(fn: (tx: Driver) => Promise<T>): Promise<T>;
    end(opts?: { timeout?: number }): Promise<void>;
  };

  const handle = (): SyncTx => ({
    async rows<T>(text: string, params: readonly unknown[] = []) {
      return (await sql.unsafe(text, params as unknown[])) as unknown as T[];
    },
    async one<T>(text: string, params: readonly unknown[] = []) {
      const r = (await sql.unsafe(text, params as unknown[])) as unknown as T[];
      return r[0] ?? null;
    },
    async exec(text: string, params: readonly unknown[] = []) {
      const r = await sql.unsafe(text, params as unknown[]);
      return r.count ?? 0;
    },
  });

  return {
    ...handle(),
    async transaction<T>(fn: (tx: SyncTx) => Promise<T>): Promise<T> {
      return await sql.begin(async (tx: Driver) => {
        // The same identity switch the application uses, scoped to this
        // transaction. Writing the catalog is service_role's job and nothing
        // else's, and `SET LOCAL` means a pooled backend cannot carry the role
        // into whatever borrows it next.
        await tx.unsafe(`select set_config('role', 'service_role', true)`);
        const inner: SyncTx = {
          async rows<R>(text: string, params: readonly unknown[] = []) {
            return (await tx.unsafe(text, params as unknown[])) as unknown as R[];
          },
          async one<R>(text: string, params: readonly unknown[] = []) {
            const r = (await tx.unsafe(text, params as unknown[])) as unknown as R[];
            return r[0] ?? null;
          },
          async exec(text: string, params: readonly unknown[] = []) {
            const r = await tx.unsafe(text, params as unknown[]);
            return r.count ?? 0;
          },
        };
        return await fn(inner);
      });
    },
    async close() {
      await sql.end({ timeout: 5 });
    },
  };
}

/**
 * The scheduler's credential check.
 *
 * These functions are deployed with the gateway's JWT verification on, so every
 * request that reaches this code already carries a bearer token whose signature
 * the platform validated against the project's JWT secret — a token only
 * Supabase can mint. What the gateway does NOT do is distinguish roles: the
 * anon key passes it too. So the one thing left to check is that the caller is
 * the service role, which is what pg_cron presents when it invokes the function
 * (it reads the service key from Vault; see schedule.sql).
 *
 * The role lives in the JWT's payload. Because the signature is already trusted,
 * reading the payload without re-verifying it is sound: an attacker holding only
 * the anon key gets a token whose role claim is `anon`, and cannot forge a
 * valid-signature token that says `service_role`. Comparing an env-injected key
 * byte-for-byte was the earlier approach and proved brittle across Supabase's
 * legacy-JWT and new API-key formats; the role claim is the stable invariant.
 */
export function authorized(req: Request): boolean {
  const header = req.headers.get('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  try {
    const pad = parts[1].length % 4 === 0 ? '' : '='.repeat(4 - (parts[1].length % 4));
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/') + pad));
    return payload.role === 'service_role';
  } catch {
    return false;
  }
}

/** The database URL a function should use, preferring the pooler. */
export function databaseUrl(): string {
  const url = Deno.env.get('SUPABASE_DB_URL') ?? Deno.env.get('DATABASE_URL');
  if (!url) throw new Error('SUPABASE_DB_URL is not set');
  return url;
}

/**
 * Records a run that failed, outside any transaction.
 *
 * The ingest opens its sync-run row inside the transaction that does the work,
 * which is right: a run that rolls back did not happen. But a *scheduled* run
 * that fails must still leave a trace, or the only evidence a nightly job died
 * is its absence from a table — and absence is what a job that never fired
 * looks like too. So the failure is written afterwards, on its own statement,
 * where the rollback cannot take it with it.
 *
 * Best effort by construction: if this throws, the original error is the one
 * worth surfacing.
 */
export async function recordFailure(
  db: SyncTx,
  kind: 'hourly_prices' | 'nightly_catalog',
  source: string,
  message: string,
): Promise<void> {
  try {
    const run = await db.one<{ id: number }>(
      `select public.start_sync_run($1::public.sync_kind, $2) as id`,
      [kind, source],
    );
    if (!run) return;
    await db.exec(`select public.finish_sync_run($1, 'failed', 0, 0, 1, $2, $3)`, [
      run.id,
      'scheduled run failed',
      message.slice(0, 2000),
    ]);
  } catch (e) {
    console.error('could not record the failure', e);
  }
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
