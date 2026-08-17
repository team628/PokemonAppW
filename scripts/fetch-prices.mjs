// Pulls live market prices from api.pokemontcg.io (TCGplayer + Cardmarket
// aggregates). Every record keeps the provider's own `updatedAt` stamp so the
// app can always say where a number came from and how stale it is.
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const OUT = new URL('../data/raw/prices/', import.meta.url).pathname;
const API = 'https://api.pokemontcg.io/v2/cards';

async function get(url, tries = 6) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 800 * 2 ** i));
    }
  }
  throw new Error(lastErr?.message ?? 'unknown');
}

await mkdir(OUT, { recursive: true });
const sets = JSON.parse(await readFile(new URL('../data/raw/sets.json', import.meta.url), 'utf8'));
const queue = sets.map((s) => s.id).filter((id) => !existsSync(`${OUT}${id}.json`));
console.log(`fetching prices for ${queue.length} sets (${sets.length - queue.length} cached)`);

let ok = 0;
const failed = [];
const workers = Array.from({ length: 3 }, async () => {
  while (queue.length) {
    const id = queue.shift();
    try {
      const rows = [];
      for (let page = 1; ; page++) {
        const url = `${API}?q=set.id:${encodeURIComponent(id)}&pageSize=250&page=${page}&select=id,tcgplayer,cardmarket`;
        const j = await get(url);
        rows.push(...(j.data ?? []));
        if (!j.data?.length || rows.length >= (j.totalCount ?? 0)) break;
      }
      await writeFile(`${OUT}${id}.json`, JSON.stringify(rows));
      ok++;
      if (ok % 20 === 0) console.log(`  ${ok} sets priced, ${queue.length} left`);
    } catch (e) {
      failed.push(`${id}:${e.message}`);
    }
  }
});
await Promise.all(workers);
console.log(`prices ok=${ok} failed=${failed.length}`);
if (failed.length) console.log('FAILED:', failed.join(', '));
