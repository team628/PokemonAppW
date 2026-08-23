import { ingestCatalog } from '../../../src/lib/sync/ingest.ts';
import { authorized, connect, databaseUrl, json, recordFailure } from '../_shared/db.ts';

/**
 * Nightly catalog reconciliation.
 *
 * Discovers new sets and cards, and refreshes the metadata of the ones already
 * known — names, numbering, rarity, artwork URLs, whether a card is a secret.
 * The catalog comes from a versioned open dataset rather than a live API, so a
 * full pass is one file plus one request per set, and there is no partial mode
 * to reason about: either the dataset is reachable or the run fails and the
 * previous catalog stands.
 *
 * The `sets` bound exists for the one case that is not a routine night — a
 * first run against an empty project, or a backfill after a long outage, where
 * a single invocation might not finish inside the function's wall clock. Left
 * unset, it does the whole catalog, which is the normal path.
 *
 * Ordering matters when the work is bounded: newest sets first. A set released
 * yesterday is the one collectors are asking about, and the one whose cards are
 * missing from the catalog entirely.
 */

interface Body {
  /** Cap the number of sets this invocation reconciles. */
  sets?: number;
  /** Reconcile these exact sets instead. For a targeted repair. */
  setIds?: string[];
  /** Skip the want-index reconciliation that normally follows. */
  skipIndex?: boolean;
}

Deno.serve(async (req) => {
  if (!authorized(req)) return json({ error: 'unauthorized' }, 401);

  const body: Body = await req.json().catch(() => ({}));
  const log: string[] = [];
  const db = connect(databaseUrl());
  const started = Date.now();

  try {
    let setIds = body.setIds;
    if (!setIds && body.sets) {
      setIds = (
        await db.rows<{ id: string }>(
          `select id from public.sets
           order by release_date desc nulls first, id
           limit $1::int`,
          [Math.min(Math.max(body.sets, 1), 1000)],
        )
      ).map((r) => r.id);
    }

    await db.transaction((tx) => ingestCatalog(tx, { setIds, log: (m) => log.push(m) }));

    // The want index is maintained incrementally by triggers as collections
    // change. This is the reconciliation backstop, and it belongs here rather
    // than on its own schedule: new cards from the run above can create new
    // wants, and rebuilding before they exist would only have to be redone.
    let indexed: Record<string, unknown> | null = null;
    if (!body.skipIndex) {
      indexed =
        (await db.one<Record<string, unknown>>('select * from public.rebuild_want_index()')) ??
        null;
      log.push(`want index rebuilt: ${JSON.stringify(indexed)}`);
    }

    return json({
      ok: true,
      scope: setIds ? { sets: setIds.length } : 'full catalog',
      wantIndex: indexed,
      seconds: Math.round((Date.now() - started) / 100) / 10,
      log,
    });
  } catch (e) {
    console.error('catalog-sync failed', e);
    await recordFailure(db, 'nightly_catalog', 'catalog-sync', (e as Error).message);
    return json({ ok: false, error: (e as Error).message, log }, 500);
  } finally {
    await db.close();
  }
});
