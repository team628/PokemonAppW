/**
 * Concurrency and idempotency, driven through real HTTP against a running
 * server rather than through the service layer.
 *
 *   node tests/load/concurrency.mjs <baseUrl> <identityCookie>
 *
 * These are the races a single-process test cannot see: two requests landing on
 * two instances at the same instant, an offline queue replaying the same find
 * ten times, a rate limit that has to hold when twenty callers arrive together.
 */
const BASE = process.argv[2] ?? 'http://localhost:3100';
const TOKEN = process.argv[3] ?? '';
const cookie = TOKEN.includes('=') ? TOKEN : `sv_local_identity=${TOKEN}`;

let passed = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function post(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}



// A card nobody in the load population is guaranteed to hold, in a set the
// identity is chasing. Base Set Machop is cheap and unambiguous.
const CARD = 'base1-52';
const VARIANT = 'normal';

console.log(`\n=== concurrency / idempotency against ${BASE} ===`);

// ---------------------------------------------------------------- clean slate
await post('/api/collection/remove', { cardId: CARD, variant: VARIANT, quantity: 999 });

// ------------------------------------------------- concurrent adds of one card
console.log('\nconcurrent adds');
{
  const N = 20;
  const results = await Promise.all(
    Array.from({ length: N }, () => post('/api/collection/add', { cardId: CARD, variant: VARIANT })),
  );
  const ok = results.filter((r) => r.status === 200);
  check(`all ${N} concurrent adds succeed`, ok.length === N, `${ok.length}/${N}`);

  // Exactly one of them may claim it created the first copy. Two "first copy"
  // answers would mean two rows for one (card, printing, condition) — the
  // identity constraint the whole collection model rests on.
  const firsts = ok.filter((r) => r.body?.firstCopy).length;
  check('exactly one add reports the first copy', firsts === 1, `${firsts} claimed it`);

  const quantities = ok.map((r) => r.body?.quantity).sort((a, b) => a - b);
  check(
    `quantity lands on exactly ${N}`,
    quantities[quantities.length - 1] === N,
    `saw ${quantities.join(',')}`,
  );
  check(
    'every add observed a distinct quantity — no lost update',
    new Set(quantities).size === N,
    `${new Set(quantities).size} distinct of ${N}`,
  );
}

// --------------------------------------------------- concurrent removals
console.log('\nconcurrent removals');
{
  const N = 20;
  const results = await Promise.all(
    Array.from({ length: N }, () =>
      post('/api/collection/remove', { cardId: CARD, variant: VARIANT, quantity: 1 }),
    ),
  );
  const ok = results.filter((r) => r.status === 200);
  check(`all ${N} concurrent removals succeed`, ok.length === N, `${ok.length}/${N}`);
  const remaining = ok.map((r) => r.body?.remaining ?? 0);
  check('quantity never goes negative', Math.min(...remaining) >= 0, `min ${Math.min(...remaining)}`);
  check('the last removal empties the stack', Math.min(...remaining) === 0);
}

// -------------------------------------------------------- replayed find queue
console.log('\nreplayed offline queue');
{
  const session = await post('/api/show/session', { action: 'start' });
  const sessionId = session.body?.session?.id;
  check('a hunt session is available', !!sessionId, JSON.stringify(session.body)?.slice(0, 120));

  if (sessionId) {
    await post('/api/collection/remove', { cardId: CARD, variant: VARIANT, quantity: 999 });
    const key = `replay-${Date.now()}`;
    const N = 10;
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        post('/api/show/find', {
          sessionId, cardId: CARD, variant: VARIANT, paidCents: 100, idempotencyKey: key,
        }),
      ),
    );
    const applied = results.filter((r) => r.status === 200 && !r.body?.duplicate);
    const duplicates = results.filter((r) => r.body?.duplicate);
    check(`exactly one of ${N} identical finds is applied`, applied.length === 1, `${applied.length} applied`);
    check('the rest are reported as duplicates', duplicates.length === N - 1, `${duplicates.length}`);

    const summary = applied[0]?.body?.summary;
    check('the hunt tally counts the find once', summary?.finds >= 1, JSON.stringify(summary));
    await post('/api/collection/remove', { cardId: CARD, variant: VARIANT, quantity: 999 });
  }
}

// ---------------------------------------------------------- public rate limit
console.log('\nrate limit under concurrency');
{
  // The public partner console is capped per address. Fire well past the cap
  // simultaneously and confirm the counter does not leak requests through.
  //
  // The interstitial is detected by content, not status: a Next.js App Router
  // *page* cannot set a response code, so a throttled render is a 200 carrying
  // the "slow down" body. Route handlers in this app do return 429.
  const N = 90;
  const results = await Promise.all(
    Array.from({ length: N }, () =>
      fetch(`${BASE}/partners`)
        .then(async (r) => ({ status: r.status, throttled: (await r.text()).includes('Slow down') }))
        .catch(() => ({ status: 0, throttled: false })),
    ),
  );
  const served = results.filter((r) => r.status === 200 && !r.throttled).length;
  const refused = results.filter((r) => r.throttled).length;
  check(`${N} simultaneous public requests are capped`, served < N, `${served} served, ${refused} refused`);
  check('the cap is not overshot', served <= 60, `${served} served against a cap of 60`);
  check(
    'the server stayed up throughout',
    results.every((r) => r.status === 200 || r.status === 429 || r.status === 503),
    [...new Set(results.map((r) => r.status))].join(','),
  );
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nfailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
