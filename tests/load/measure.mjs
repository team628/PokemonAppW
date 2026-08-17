/**
 * Load, denial-of-service and payload measurements against a running server.
 *
 *   node tests/load/measure.mjs <baseUrl> <sessionToken> [label]
 *
 * Prints one line per probe so before/after runs diff cleanly.
 */
const BASE = process.argv[2] ?? 'http://localhost:3100';
const TOKEN = process.argv[3] ?? '';
const LABEL = process.argv[4] ?? '';

const cookie = TOKEN ? { cookie: `sv_session=${TOKEN}` } : {};

async function probe(path, { auth = true, timeoutMs = 300_000 } = {}) {
  const t0 = performance.now();
  const res = await fetch(BASE + path, {
    headers: auth ? cookie : {},
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await res.arrayBuffer();
  return { ms: Math.round(performance.now() - t0), bytes: body.byteLength, status: res.status };
}

function row(name, r) {
  console.log(
    `${name.padEnd(34)} ${String(r.ms).padStart(7)}ms  ${String(r.bytes).padStart(10)} bytes  [${r.status}]`,
  );
}

console.log(`\n=== ${LABEL || BASE} ===`);

for (const p of [
  '/partners',
  '/app',
  '/app/trade',
  '/app/collection',
  '/app/sets',
  '/app/sets/sv3pt5?mode=master',
  '/app/moves',
  '/app/show',
]) {
  try {
    row(p, await probe(p));
  } catch (e) {
    console.log(`${p.padEnd(34)}   TIMEOUT/ERROR (${e.name})`);
  }
}

// Denial of service: does unauthenticated traffic on a public page stall
// everybody else? Baseline first, then under five concurrent requests.
const idle = await probe('/signin', { auth: false });
row('/signin (idle baseline)', idle);

const flood = Array.from({ length: 5 }, () =>
  fetch(`${BASE}/partners`, { signal: AbortSignal.timeout(300_000) })
    .then((r) => r.arrayBuffer())
    .catch(() => null),
);
await new Promise((r) => setTimeout(r, 500));
let underLoad;
try {
  underLoad = await probe('/signin', { auth: false });
  row('/signin (5x concurrent /partners)', underLoad);
} catch {
  console.log('/signin (5x concurrent /partners)   TIMEOUT');
  underLoad = { ms: -1 };
}
await Promise.all(flood);

console.log(
  `\ndegradation under trivial unauthenticated load: ${
    underLoad.ms < 0 ? 'timeout' : `${(underLoad.ms / Math.max(1, idle.ms)).toFixed(0)}x`
  }`,
);
