/**
 * The pinned provider-data snapshot.
 *
 * Normal PR validation must be deterministic. The catalog is served from a
 * mutable branch and prices come from a third-party API that returns HTTP 500
 * on individual sets from time to time — so a workflow that fetches live is a
 * workflow whose result depends on someone else's afternoon.
 *
 * This vendors a capture of real provider data into the repository. It is not
 * synthesized: every set, card, rarity, release date and price in it came from
 * the providers on the date recorded in MANIFEST.json. That is what lets the
 * integrity assertions — 174 sets, >85% price coverage, no pre-2002 reverse
 * holos — keep their meaning while running offline.
 *
 * It goes stale by design. `.github/workflows/ci-live.yml` fetches live on a
 * schedule and fails if the live corpus has drifted away from this one, which
 * is the signal to re-capture.
 *
 *   node scripts/pg/snapshot.mjs restore   # snapshot -> data/raw
 *   node scripts/pg/snapshot.mjs capture   # data/raw -> snapshot (+ manifest)
 *   node scripts/pg/snapshot.mjs verify    # check archives against the manifest
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SNAP = path.join(ROOT, 'data', 'snapshot');
const RAW = path.join(ROOT, 'data', 'raw');
const ARCHIVES = ['catalog.tar.gz', 'prices.tar.gz'];
const MANIFEST = path.join(SNAP, 'MANIFEST.json');

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

function restore() {
  for (const a of ARCHIVES) {
    const p = path.join(SNAP, a);
    if (!existsSync(p)) throw new Error(`missing snapshot archive: ${a}`);
  }
  verify();
  mkdirSync(RAW, { recursive: true });
  for (const a of ARCHIVES) {
    execFileSync('tar', ['-xzf', path.join(SNAP, a), '-C', RAW], { stdio: 'inherit' });
  }
  const m = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  console.log(
    `restored snapshot captured ${m.capturedOn}: ` +
      `${readdirSync(path.join(RAW, 'cards')).length} set files, ` +
      `${readdirSync(path.join(RAW, 'prices')).length} price files`,
  );
}

function capture() {
  mkdirSync(SNAP, { recursive: true });
  execFileSync('tar', ['-czf', path.join(SNAP, 'catalog.tar.gz'), '-C', RAW, 'sets.json', 'cards'], { stdio: 'inherit' });
  execFileSync('tar', ['-czf', path.join(SNAP, 'prices.tar.gz'), '-C', RAW, 'prices'], { stdio: 'inherit' });

  const manifest = {
    capturedOn: new Date().toISOString().slice(0, 10),
    catalogSource: 'https://raw.githubusercontent.com/PokemonTCG/pokemon-tcg-data/master',
    priceSource: 'https://api.pokemontcg.io/v2 (TCGplayer USD + Cardmarket EUR aggregates)',
    setFiles: readdirSync(path.join(RAW, 'cards')).length,
    priceFiles: readdirSync(path.join(RAW, 'prices')).length,
    sha256: Object.fromEntries(ARCHIVES.map((a) => [a, sha256(path.join(SNAP, a))])),
  };
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`captured ${manifest.setFiles} set files, ${manifest.priceFiles} price files`);
}

function verify() {
  const m = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  for (const a of ARCHIVES) {
    const actual = sha256(path.join(SNAP, a));
    if (actual !== m.sha256[a]) {
      throw new Error(`${a} does not match the manifest (${actual} != ${m.sha256[a]})`);
    }
  }
  return m;
}

const mode = process.argv[2] ?? 'restore';
if (mode === 'restore') restore();
else if (mode === 'capture') capture();
else if (mode === 'verify') { const m = verify(); console.log(`snapshot verified, captured ${m.capturedOn}`); }
else { console.error(`unknown mode: ${mode}`); process.exit(1); }
