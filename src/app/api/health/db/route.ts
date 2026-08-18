import { getPool } from '@/lib/db/pg';

/**
 * TEMPORARY diagnostic — production database connectivity probe.
 *
 * Added only to identify why the deployed app cannot open a database
 * connection (DB-backed pages return 500). It attempts the most trivial
 * possible query on the SAME pool the application uses, and reports whether it
 * succeeded plus a *sanitised* error classification.
 *
 * It deliberately returns nothing that could be sensitive: no connection
 * string, host, port, username, password, SQL, or stack trace. Only:
 *   - ok:      boolean
 *   - code:    the short symbolic error code (e.g. ECONNREFUSED, 28P01) — never
 *              free text that could carry a host or credential
 *   - message: a first line with hosts, IPs, URIs and quoted identifiers
 *              stripped out
 *
 * REMOVE this route once the connection is fixed.
 */

export const dynamic = 'force-dynamic';

/** Strip anything that could be a host, IP, URI, port, or quoted identifier. */
function sanitize(raw: string): string {
  let s = raw.split('\n')[0]!.slice(0, 200);
  s = s
    // full postgres URIs, should they ever appear
    .replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted-uri]')
    // user@host forms
    .replace(/\S+@\S+/g, '[redacted]')
    // any supabase / pooler / aws hostnames
    .replace(/[a-z0-9.-]*\.(?:supabase\.(?:co|com)|pooler\.supabase\.com|amazonaws\.com)/gi, '[redacted-host]')
    // bare dotted hostnames (three+ labels) and IPv4 addresses
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[redacted-ip]')
    .replace(/\b(?:[a-z0-9-]+\.){2,}[a-z]{2,}\b/gi, '[redacted-host]')
    // :port
    .replace(/:\d{2,5}\b/g, ':[port]')
    // "quoted identifiers" such as user names
    .replace(/"[^"]*"/g, '"[redacted]"');
  return s;
}

export async function GET() {
  const started = Date.now();
  try {
    // A short race so the probe can never hang the function.
    const result = await Promise.race([
      getPool().query('select 1 as ok'),
      new Promise((_, reject) =>
        setTimeout(() => reject(Object.assign(new Error('probe timeout'), { code: 'PROBE_TIMEOUT' })), 8000),
      ),
    ]);
    void result;
    return Response.json({ ok: true, code: 'OK', message: `connected in ${Date.now() - started}ms` });
  } catch (err) {
    const e = err as { code?: unknown; message?: unknown };
    const code = typeof e.code === 'string' && /^[A-Z0-9_]{2,40}$/.test(e.code) ? e.code : 'UNKNOWN';
    const message = sanitize(typeof e.message === 'string' ? e.message : 'error');
    return Response.json({ ok: false, code, message }, { status: 503 });
  }
}
