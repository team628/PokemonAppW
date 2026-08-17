// Downloads the canonical Pokemon TCG catalog (sets + cards) from the
// PokemonTCG/pokemon-tcg-data repository. This is the same dataset that backs
// api.pokemontcg.io, but served as static JSON so ingestion is reproducible.
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const BASE = 'https://raw.githubusercontent.com/PokemonTCG/pokemon-tcg-data/master';
const OUT = new URL('../data/raw/', import.meta.url).pathname;

async function get(url, tries = 5) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(45000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 500 * 2 ** i));
    }
  }
  throw new Error(`failed ${url}: ${lastErr?.message}`);
}

await mkdir(OUT + 'cards', { recursive: true });

const setsPath = OUT + 'sets.json';
if (!existsSync(setsPath)) await writeFile(setsPath, await get(`${BASE}/sets/en.json`));
const sets = JSON.parse(await readFile(setsPath, 'utf8'));
console.log(`sets: ${sets.length}`);

let done = 0;
const queue = [...sets];
const workers = Array.from({ length: 8 }, async () => {
  while (queue.length) {
    const s = queue.shift();
    const p = `${OUT}cards/${s.id}.json`;
    if (!existsSync(p)) {
      try {
        await writeFile(p, await get(`${BASE}/cards/en/${s.id}.json`));
      } catch (e) {
        console.error(`MISS ${s.id}: ${e.message}`);
      }
    }
    if (++done % 25 === 0) console.log(`  ${done}/${sets.length}`);
  }
});
await Promise.all(workers);
console.log(`catalog downloaded: ${done} set files`);
