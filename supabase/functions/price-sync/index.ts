import { ingestPrices } from '../../../src/lib/sync/ingest.ts';
import { authorized, connect, databaseUrl, json, recordFailure } from '../_shared/db.ts';

/**
 * Hourly incremental price refresh.
 *
 * The provider serves prices a set at a time, so a set is the unit of work.
 * Refreshing all 174 every hour would be 174 provider calls an hour for data
 * that moves daily; refreshing none is worse. So each run takes a bounded slice
 * of the sets that are actually due, most-wanted first.
 *
 * "Due" is the important half. Ordering by demand alone would refresh the same
 * dozen popular sets forever and never touch the rest, so a set only becomes a
 * candidate once its prices are older than `staleAfterHours`. Among the
 * candidates, the sets collectors are actively chasing go first — which is what
 * makes this an intent-driven refresh rather than a round robin.
 *
 * At the default twelve sets an hour that is 288 set-refreshes a day against a
 * 174-set catalog: every set daily, with headroom for the popular ones to come
 * round more than once.
 *
 * Everything else — batching, partial-run handling, last-known-good prices,
 * historical observations, sync logging — is the shared ingest core's, the same
 * code the scripts and CI run. This function decides *which* sets and nothing
 * about *how*.
 */

interface Body {
  /** Sets to refresh in this run. */
  sets?: number;
  /** A set is a candidate once its prices are older than this. */
  staleAfterHours?: number;
  /** Refresh these exact sets instead, ignoring the schedule. For backfills. */
  setIds?: string[];
}

/**
 * The sets due for a refresh, most-wanted first.
 *
 * `want_index` is the open-demand snapshot the triggers maintain, so this is
 * ordered by what collectors are actually missing right now rather than by
 * anything modelled. A set with no prices at all sorts first: never-priced is
 * the stalest thing there is.
 */
const DUE_SETS = `
  with demand as (
    select c.set_id, sum(w.collectors)::bigint as wants
    from public.want_index w
    join public.cards c on c.id = w.card_id
    where w.collectors > 0
    group by c.set_id
  ),
  freshness as (
    select c.set_id, min(p.fetched_at) as oldest
    from public.prices p
    join public.cards c on c.id = p.card_id
    group by c.set_id
  )
  select s.id,
         coalesce(d.wants, 0)::bigint as wants,
         f.oldest
  from public.sets s
  left join demand d on d.set_id = s.id
  left join freshness f on f.set_id = s.id
  where f.oldest is null
     or f.oldest < now() - make_interval(hours => $2::int)
  order by coalesce(d.wants, 0) desc, f.oldest asc nulls first, s.id
  limit $1::int
`;

Deno.serve(async (req) => {
  if (!authorized(req)) return json({ error: 'unauthorized' }, 401);

  const body: Body = await req.json().catch(() => ({}));
  const limit = Math.min(Math.max(body.sets ?? 12, 1), 174);
  const staleAfterHours = Math.min(Math.max(body.staleAfterHours ?? 20, 1), 24 * 30);

  const log: string[] = [];
  const db = connect(databaseUrl());
  const started = Date.now();

  try {
    const setIds =
      body.setIds?.length
        ? body.setIds
        : (
            await db.rows<{ id: string; wants: number; oldest: string | null }>(DUE_SETS, [
              limit,
              staleAfterHours,
            ])
          ).map((r) => r.id);

    if (!setIds.length) {
      // Not an error and not a failure: everything is fresh. Reported as such
      // rather than logged as a run that wrote nothing.
      return json({ ok: true, refreshed: [], note: 'no sets due for refresh' });
    }

    // A caller can name sets that are not in the catalog. The ingest quietly
    // skips them, so saying so here is the difference between a report and a
    // claim — `refreshed` must name what was actually refreshed.
    const known = new Set(
      (
        await db.rows<{ id: string }>('select id from public.sets where id = any($1::text[])', [
          setIds,
        ])
      ).map((r) => r.id),
    );
    const unknown = setIds.filter((id) => !known.has(id));
    const scoped = setIds.filter((id) => known.has(id));

    if (!scoped.length) {
      return json({ ok: false, error: 'none of the requested sets are in the catalog', unknown }, 400);
    }

    await db.transaction((tx) => ingestPrices(tx, { setIds: scoped, log: (m) => log.push(m) }));

    return json({
      ok: true,
      refreshed: scoped,
      ...(unknown.length ? { notInCatalog: unknown } : {}),
      seconds: Math.round((Date.now() - started) / 100) / 10,
      log,
    });
  } catch (e) {
    // The ingest's own sync-run row rolls back with the work, so a total
    // failure would otherwise leave no trace at all. Write one that survives.
    console.error('price-sync failed', e);
    await recordFailure(db, 'hourly_prices', 'price-sync', (e as Error).message);
    return json({ ok: false, error: (e as Error).message, log }, 500);
  } finally {
    await db.close();
  }
});
