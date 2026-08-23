/**
 * Real card artwork: the URLs the application renders, fetched from the real
 * provider CDN.
 *
 *   node tests/e2e/artwork.mjs <baseUrl> [identityCookie]
 *
 * The companion to `no-artwork.mjs`. That suite fails every off-origin request
 * on purpose and asserts the product stays usable without artwork; this one
 * asserts the artwork is really there when the network is.
 *
 * Deliberately not a browser run. What is being checked is what the server
 * sends and what the CDN returns for it, and both are plain HTTP — putting a
 * browser in between would only add a dependency on the browser being able to
 * reach the internet, which is not true everywhere this needs to run. The
 * browser-side behaviour when artwork *fails* is `no-artwork.mjs`'s job, and
 * that one does need a browser.
 *
 * Nothing here is stubbed. Where the CDN cannot be reached, the affected checks
 * are reported BLOCKED rather than passed against a substitute.
 */

const BASE = process.argv[2] ?? 'http://localhost:3100';
const COOKIE = process.argv[3] ?? '';
const SET = 'sv3pt5';

let passed = 0;
const failures = [];
const blocked = [];
function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
function block(name, why) {
  blocked.push(`${name} — ${why}`);
  console.log(`  BLOCKED ${name} — ${why}`);
}

const headers = COOKIE ? { cookie: COOKIE } : {};
const getHtml = async (path) => {
  const res = await fetch(BASE + path, { headers, signal: AbortSignal.timeout(60000) });
  return { status: res.status, html: await res.text() };
};

/** Width and height straight out of the PNG or JPEG header. */
function imageSize(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) {
        i++;
        continue;
      }
      const m = buf[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return null;
}

/** Every `<img>` the server rendered inside a card slot. */
function cardImages(html) {
  const out = [];
  // Card slots are the only place `card-art` appears, and the image is the
  // first element inside one.
  for (const block of html.split('card-art').slice(1)) {
    const img = block.slice(0, 900).match(/<img\b[^>]*>/);
    if (!img) continue;
    const src = img[0].match(/\ssrc="([^"]+)"/)?.[1];
    const alt = img[0].match(/\salt="([^"]*)"/)?.[1];
    const loading = img[0].match(/\sloading="([^"]+)"/)?.[1];
    if (src) out.push({ src: src.replace(/&amp;/g, '&'), alt, loading });
  }
  return out;
}

const urls = new Set();
let heroUrl = null;

try {
  // ------------------------------------------------------- what the server sends
  for (const [label, path] of [
    ['set grid', `/app/sets/${SET}?mode=master`],
    ['dashboard', '/app'],
    ['card detail', '/app/cards/base1-4'],
    ['card show', '/app/show'],
    ['collection', '/app/collection'],
    ['binder', '/app/binder'],
    ['partner console', '/partners'],
  ]) {
    console.log(`\n${label}`);
    const { status, html } = await getHtml(path);
    check(`${label}: renders`, status === 200, `HTTP ${status}`);
    if (status !== 200) continue;

    const imgs = cardImages(html);
    if (imgs.length === 0) {
      console.log('  ---- no artwork on this screen for this collector');
      continue;
    }
    check(
      `${label}: every card image points at the provider over HTTPS`,
      imgs.every((i) => /^https:\/\//.test(i.src)),
      `${imgs.length} images`,
    );
    check(
      `${label}: every card image carries alternative text`,
      imgs.every((i) => (i.alt ?? '').length > 0),
      `${imgs.filter((i) => !(i.alt ?? '').length).length} without`,
    );
    for (const i of imgs) urls.add(i.src);
    if (label === 'card detail') heroUrl = imgs[0].src;
  }

  // Off-screen artwork must not be fetched eagerly, or a large set costs
  // hundreds of downloads before the first card is on screen.
  const grid = cardImages((await getHtml(`/app/sets/${SET}?mode=master`)).html);
  const lazy = grid.filter((i) => i.loading === 'lazy').length;
  check('grid artwork is lazily loaded', grid.length > 0 && lazy === grid.length, `${lazy} of ${grid.length}`);

  // The detail page is the one place the large scan is worth the bytes.
  check('the detail page asks for a different asset than the grid', !!heroUrl && /hires|large/.test(heroUrl), heroUrl ?? 'none');

  check('the application rendered artwork URLs to check', urls.size > 0, `${urls.size} distinct`);

  // ------------------------------------------------------------- the images
  console.log('\nfetching the artwork the application asked for');
  const sample = [...urls].slice(0, 40);
  let ok = 0;
  const problems = [];
  let unreachable = null;

  for (const url of sample) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) {
        problems.push(`HTTP ${res.status} ${url.slice(-40)}`);
        continue;
      }
      const type = res.headers.get('content-type') ?? '';
      const size = imageSize(Buffer.from(await res.arrayBuffer()));
      if (!type.startsWith('image/')) problems.push(`${type} ${url.slice(-40)}`);
      else if (!size) problems.push(`undecodable ${url.slice(-40)}`);
      else if (Math.abs(size.h / size.w - 342 / 245) > 0.03) {
        problems.push(`${size.w}x${size.h} ${url.slice(-40)}`);
      } else ok++;
    } catch (e) {
      unreachable = e.message;
      break;
    }
  }

  if (unreachable) {
    block(
      'the provider CDN serves the artwork the application renders',
      `no route to the image host from here (${unreachable}) — the URLs are asserted above`,
    );
  } else {
    check(
      'every sampled image is card-shaped image data',
      problems.length === 0 && ok > 0,
      `${ok} of ${sample.length}${problems.length ? ` — ${problems.slice(0, 3).join('; ')}` : ''}`,
    );
    if (heroUrl) {
      const size = imageSize(Buffer.from(await (await fetch(heroUrl)).arrayBuffer()));
      check('the detail image is a high-resolution scan', (size?.w ?? 0) > 400, `${size?.w}x${size?.h}`);
    }
  }
} catch (err) {
  failures.push(`threw: ${err.message}`);
  console.error('\nERROR', err);
}

console.log(
  `\n${passed} passed, ${failures.length} failed${blocked.length ? `, ${blocked.length} blocked` : ''}`,
);
if (blocked.length) {
  console.log('\nblocked:');
  for (const b of blocked) console.log(`  - ${b}`);
}
if (failures.length) {
  console.log('\nfailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
