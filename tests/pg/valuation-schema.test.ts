import { afterAll, describe, expect, it } from 'vitest';
import { withIdentity, withServiceRole, closePool } from '@/lib/db/pg';

/**
 * Valuation engine schema (migration 0020) — boundary + safety.
 *
 * The estimator ships behind an OFF flag and writes nothing yet; these lock the
 * security boundary so an estimate can never leak or be mistaken for observed
 * market data:
 *  - card_valuations is world-readable (public valuation metadata, like prices);
 *  - valuation_estimates (the internal model log) is service_role-only;
 *  - the setvalue_estimates_enabled flag defaults OFF.
 */

afterAll(async () => {
  await closePool();
});

describe('valuation engine schema', () => {
  it('ships with SetValue Estimates OFF by default', async () => {
    const [{ enabled }] = await withServiceRole((tx) =>
      tx.rows<{ enabled: boolean }>("select enabled from public.app_flags where key = 'setvalue_estimates_enabled'"),
    );
    expect(enabled).toBe(false);
  });

  it('exposes card_valuations to anonymous readers (world-read like the catalog)', async () => {
    // No rows yet, but the SELECT must be permitted (policy present), not blocked.
    const rows = await withIdentity(null, (tx) =>
      tx.rows("select card_id from public.card_valuations limit 1"),
    );
    expect(Array.isArray(rows)).toBe(true);
  });

  it('keeps the internal estimate log private (service_role only)', async () => {
    await expect(
      withIdentity(null, (tx) => tx.rows('select id from public.valuation_estimates limit 1')),
    ).rejects.toThrow(/permission denied|row-level security/i);
  });

  it('rejects an estimate row that lacks model provenance (class/provenance invariant)', async () => {
    // A SETVALUE_ESTIMATE with no model_version violates the check constraint —
    // an estimate can never be stored without identifying the model.
    await expect(
      withServiceRole((tx) =>
        tx.exec(
          `insert into public.card_valuations (card_id, variant, valuation_class, value_cents)
           values ('base1-4','holofoil','SETVALUE_ESTIMATE', 1000)`,
        ),
      ),
    ).rejects.toThrow(/valuation_class_provenance|violates check/i);
  });
});
