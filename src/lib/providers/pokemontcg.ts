import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import type {
  CardDataProvider,
  ProviderCard,
  ProviderPriceQuote,
  ProviderSet,
} from './types';

/**
 * pokemontcg.io provider.
 *
 * Catalog comes from the PokemonTCG open dataset, prices from the API's
 * republished TCGplayer and Cardmarket figures. Reads a local mirror when one
 * is present (`data/raw`, populated by scripts/fetch-*.mjs) so ingest is
 * reproducible and CI does not depend on a third party being up; otherwise it
 * calls the API directly.
 *
 * This module is shared: it runs under Node (the app, CI, the ingest scripts)
 * and under Deno (the Supabase Edge Functions). Deno's edge runtime does not
 * expose a `process` global, so environment and working-directory access go
 * through the two helpers below rather than touching `process` directly — which
 * would throw at module load under Deno. Under Node the helpers resolve to
 * `process.env` / `process.cwd()` exactly as before.
 */

/** Read an environment variable in whichever runtime this is loaded in. */
function env(name: string): string | undefined {
  const g = globalThis as {
    Deno?: { env?: { get(k: string): string | undefined } };
    process?: { env?: Record<string, string | undefined> };
  };
  return g.Deno?.env?.get(name) ?? g.process?.env?.[name];
}

/** The working directory, or '.' where there is none (a bundled Edge Function). */
function cwd(): string {
  const g = globalThis as { process?: { cwd?: () => string } };
  return g.process?.cwd ? g.process.cwd() : '.';
}

const CATALOG_BASE = 'https://raw.githubusercontent.com/PokemonTCG/pokemon-tcg-data/master';
const API_BASE = env('POKEMONTCG_API_BASE') ?? 'https://api.pokemontcg.io/v2';
const MIRROR = path.join(cwd(), 'data', 'raw');

/**
 * Offline mode. When set, any request that would leave the machine is an error
 * rather than a silent network call.
 *
 * This is what makes deterministic CI provable instead of assumed: the mirror
 * is meant to satisfy every read, and a missing file would otherwise fall
 * through to the live API and quietly reintroduce the flakiness the snapshot
 * exists to remove.
 */
function offline(): boolean {
  return env('SETVALUE_PROVIDER_OFFLINE') === '1';
}

async function getJson<T>(url: string, tries = 5): Promise<T> {
  if (offline()) {
    throw new Error(
      `refusing to fetch ${url}: SETVALUE_PROVIDER_OFFLINE is set and this is not in the local mirror`,
    );
  }
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const headers: Record<string, string> = {};
      const apiKey = env('POKEMONTCG_API_KEY'); if (apiKey) headers['X-Api-Key'] = apiKey;
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as T;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 500 * 2 ** i));
    }
  }
  throw new Error(`provider request failed: ${url}: ${(lastErr as Error)?.message}`);
}

function mirrored<T>(relative: string): T | null {
  // No filesystem, no mirror: a bundled Edge Function has neither `process` nor
  // `data/raw`, so it always fetches live. Returning early also keeps the
  // node:fs calls below off the Deno path entirely.
  if (!(globalThis as { process?: unknown }).process) return null;
  const p = path.join(MIRROR, relative);
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as T) : null;
}

interface RawSet {
  id: string; name: string; series: string; printedTotal: number; total: number;
  ptcgoCode?: string; releaseDate?: string; updatedAt?: string;
  images?: { symbol?: string; logo?: string };
}
interface RawCard {
  id: string; name: string; number: string; supertype?: string; subtypes?: string[];
  rarity?: string; artist?: string; hp?: string; types?: string[];
  nationalPokedexNumbers?: number[]; flavorText?: string;
  images?: { small?: string; large?: string };
}

export const pokemonTcgProvider: CardDataProvider = {
  id: 'pokemontcg',
  displayName: 'pokemontcg.io (TCGplayer + Cardmarket)',
  requestsPerMinute: 100,

  async listSets(): Promise<ProviderSet[]> {
    const raw =
      mirrored<RawSet[]>('sets.json') ??
      (await getJson<RawSet[]>(`${CATALOG_BASE}/sets/en.json`));
    return raw.map((s) => ({
      id: s.id,
      name: s.name,
      series: s.series,
      printedTotal: s.printedTotal ?? 0,
      total: s.total ?? 0,
      ptcgoCode: s.ptcgoCode ?? null,
      releaseDate: s.releaseDate ?? null,
      symbolUrl: s.images?.symbol ?? null,
      logoUrl: s.images?.logo ?? null,
      updatedAt: s.updatedAt ?? null,
    }));
  },

  async listCards(setId: string): Promise<ProviderCard[]> {
    const raw =
      mirrored<RawCard[]>(path.join('cards', `${setId}.json`)) ??
      (await getJson<RawCard[]>(`${CATALOG_BASE}/cards/en/${setId}.json`).catch(() => []));
    return raw.map((c) => ({
      id: c.id,
      setId,
      number: c.number,
      name: c.name,
      supertype: c.supertype ?? null,
      subtypes: c.subtypes ?? [],
      rarity: c.rarity ?? null,
      artist: c.artist ?? null,
      hp: c.hp ?? null,
      types: c.types ?? [],
      nationalPokedexNumbers: c.nationalPokedexNumbers ?? [],
      flavorText: c.flavorText ?? null,
      imageSmall: c.images?.small ?? null,
      imageLarge: c.images?.large ?? null,
    }));
  },

  async listPrices(setId: string): Promise<ProviderPriceQuote[]> {
    const mirror = mirrored<ProviderPriceQuote[]>(path.join('prices', `${setId}.json`));
    if (mirror) return mirror;

    const out: ProviderPriceQuote[] = [];
    for (let page = 1; ; page++) {
      const j = await getJson<{ data: ProviderPriceQuote[]; totalCount: number }>(
        `${API_BASE}/cards?q=set.id:${encodeURIComponent(setId)}&pageSize=250&page=${page}&select=id,tcgplayer,cardmarket`,
      );
      const rows = (j.data ?? []).map((d) => ({ ...d, cardId: (d as unknown as { id: string }).id }));
      out.push(...rows);
      if (!rows.length || out.length >= (j.totalCount ?? 0)) break;
    }
    return out;
  },

  async pricesForCards(cardIds: string[]): Promise<ProviderPriceQuote[]> {
    if (!cardIds.length) return [];
    const out: ProviderPriceQuote[] = [];
    // The API takes an OR query; batch to keep URLs sane.
    const BATCH = 40;
    for (let i = 0; i < cardIds.length; i += BATCH) {
      const q = cardIds
        .slice(i, i + BATCH)
        .map((id) => `id:"${id}"`)
        .join(' OR ');
      const j = await getJson<{ data: (ProviderPriceQuote & { id: string })[] }>(
        `${API_BASE}/cards?q=${encodeURIComponent(q)}&pageSize=250&select=id,tcgplayer,cardmarket`,
      );
      out.push(...(j.data ?? []).map((d) => ({ ...d, cardId: d.id })));
    }
    return out;
  },
};

/** Provider registry — the single place a deployment chooses its source. */
export const providers: Record<string, CardDataProvider> = {
  [pokemonTcgProvider.id]: pokemonTcgProvider,
};

export function activeProvider(): CardDataProvider {
  const id = env('CARD_DATA_PROVIDER') ?? pokemonTcgProvider.id;
  const p = providers[id];
  if (!p) throw new Error(`unknown card data provider: ${id}`);
  return p;
}
