import { getPool } from '@/lib/db/pg';
import net from 'node:net';
import tls from 'node:tls';

/**
 * TEMPORARY diagnostic — production database connectivity probe.
 *
 * Added only to identify why the deployed app cannot open a database
 * connection (DB-backed pages return 500). Two modes:
 *
 *   GET /api/health/db
 *     Attempts `select 1` on the SAME pool the application uses and reports
 *     { ok, code, message } with hosts, IPs, URIs, ports, and quoted
 *     identifiers stripped from the message. No connection string,
 *     credentials, SQL, or stack traces are exposed.
 *
 *   GET /api/health/db?capture=certs
 *     Opens a raw TLS session to the pooler (Postgres SSLRequest handshake)
 *     WITHOUT verifying the chain, purely to read the certificate chain the
 *     server presents, and returns each certificate's subject/issuer and PEM.
 *     X.509 certificates are public by definition — a server hands them to
 *     every client during the handshake — so nothing secret is exposed. This
 *     is how we learn which CA to pin so the app can then verify the chain
 *     (rejectUnauthorized stays true in the app itself; this probe's
 *     no-verify socket is used only to observe the public certificate and is
 *     immediately discarded).
 *
 * REMOVE this route once the connection is fixed.
 */

export const dynamic = 'force-dynamic';

/** Strip anything that could be a host, IP, URI, port, or quoted identifier. */
function sanitize(raw: string): string {
  let s = raw.split('\n')[0]!.slice(0, 200);
  s = s
    .replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted-uri]')
    .replace(/\S+@\S+/g, '[redacted]')
    .replace(/[a-z0-9.-]*\.(?:supabase\.(?:co|com)|pooler\.supabase\.com|amazonaws\.com)/gi, '[redacted-host]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[redacted-ip]')
    .replace(/\b(?:[a-z0-9-]+\.){2,}[a-z]{2,}\b/gi, '[redacted-host]')
    .replace(/:\d{2,5}\b/g, ':[port]')
    .replace(/"[^"]*"/g, '"[redacted]"');
  return s;
}

function derToPem(der: Buffer): string {
  const b64 = der.toString('base64').replace(/(.{64})/g, '$1\n');
  return `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;
}

/** Capture the certificate chain the pooler presents (public data). */
async function captureCerts(): Promise<Response> {
  const url = process.env.SUPABASE_DB_URL ?? process.env.DATABASE_URL ?? '';
  let host = '';
  let port = 6543;
  try {
    const u = new URL(url);
    host = u.hostname;
    port = Number(u.port || 6543);
  } catch {
    return Response.json({ ok: false, code: 'NO_DB_URL', message: 'no database url' }, { status: 503 });
  }

  return await new Promise<Response>((resolve) => {
    const socket = net.connect({ host, port });
    const done = (r: Response) => {
      try { socket.destroy(); } catch { /* noop */ }
      resolve(r);
    };
    const timer = setTimeout(() => done(Response.json({ ok: false, code: 'TIMEOUT', message: 'handshake timeout' }, { status: 503 })), 9000);

    socket.on('error', (e: NodeJS.ErrnoException) =>
      done(Response.json({ ok: false, code: e.code ?? 'SOCKET_ERR', message: 'socket error' }, { status: 503 })),
    );

    socket.once('connect', () => {
      // Postgres SSLRequest: int32 length=8, int32 code=80877103.
      const req = Buffer.from([0x00, 0x00, 0x00, 0x08, 0x04, 0xd2, 0x16, 0x2f]);
      socket.write(req);
    });

    socket.once('data', (buf: Buffer) => {
      if (buf[0] !== 0x53 /* 'S' */) {
        return done(Response.json({ ok: false, code: 'NO_SSL', message: 'server declined SSL' }, { status: 503 }));
      }
      const secure = tls.connect({ socket, servername: host, rejectUnauthorized: false }, () => {
        clearTimeout(timer);
        const chain: { subject: string; issuer: string; pem: string }[] = [];
        const seen = new Set<string>();
        let cert = secure.getPeerCertificate(true) as tls.DetailedPeerCertificate | undefined;
        while (cert && cert.raw && !seen.has(cert.fingerprint256)) {
          seen.add(cert.fingerprint256);
          const nameOf = (x: tls.PeerCertificate['subject']) =>
            [x?.O, x?.CN].filter(Boolean).join(' / ') || '(unknown)';
          chain.push({ subject: nameOf(cert.subject), issuer: nameOf(cert.issuer), pem: derToPem(cert.raw) });
          if (cert.issuerCertificate && cert.issuerCertificate !== cert) cert = cert.issuerCertificate;
          else break;
        }
        done(Response.json({ ok: true, code: 'OK', count: chain.length, chain }));
      });
      secure.on('error', (e: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        done(Response.json({ ok: false, code: e.code ?? 'TLS_ERR', message: 'tls error' }, { status: 503 }));
      });
    });
  });
}

export async function GET(req: Request) {
  if (new URL(req.url).searchParams.get('capture') === 'certs') {
    return captureCerts();
  }
  const started = Date.now();
  try {
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
