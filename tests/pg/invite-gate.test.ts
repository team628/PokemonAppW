import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { withServiceRole, closePool } from '@/lib/db/pg';

/**
 * The invite-only beta gate (migrations 0015 + 0016) is the ONE choke point every
 * account-creation path funnels through: a BEFORE INSERT trigger on auth.users.
 * Its own comment is explicit — "the check is the database's, never this form's."
 *
 * These tests exercise that production trigger directly, in the isolated CI
 * database, by performing the exact auth.users insert Supabase GoTrue performs on
 * signup — id, email, and raw_user_meta_data carrying the invite_code — and prove
 * the gate VALIDATES and atomically CONSUMES a real code, rejects a reused code
 * past its limit, and rejects a missing or unknown code. Nothing here is a bypass
 * or a stub: it seeds a genuine code via the owner function create_invite_code(),
 * flips the real flag via set_beta_invite_only(), and asserts against the real
 * invite_codes.uses counter. Everything is torn down in afterAll so the flag
 * returns OFF (its fresh-DB default) and no sibling suite is affected.
 *
 * The browser e2e (tests/e2e/flow.mjs) drives the same signup form with a seeded
 * code, but CI runs local-auth (no Supabase project), where the gate flag is off;
 * consumption through the trigger is proven HERE, against the identical gate.
 */

const CODE = 'E2E_GATE_TEST_CODE';
const emailFor = () => `invite-gate-${randomUUID()}@example.test`;

// Insert into auth.users exactly as signup does, with the invite code (or not)
// in raw_user_meta_data. Returns the new id; throws on the gate's P0001.
async function signupInsert(code: string | null) {
  return withServiceRole(async (tx) => {
    const id = randomUUID();
    const meta = code === null
      ? `jsonb_build_object('display_name','Gate Test')`
      : `jsonb_build_object('display_name','Gate Test','invite_code',$3::text)`;
    const params: unknown[] = code === null ? [id, emailFor()] : [id, emailFor(), code];
    await tx.exec(
      `insert into auth.users (id, email, raw_user_meta_data)
       values ($1::uuid, $2::citext, ${meta})`,
      params,
    );
    return id;
  });
}

const usesOf = (code: string) =>
  withServiceRole((tx) =>
    tx.one<{ uses: number; max_uses: number | null }>(
      `select uses, max_uses from public.invite_codes where code = upper($1)`,
      [code],
    ),
  );

afterAll(async () => {
  // Restore the fresh-DB default and remove everything this suite created, so the
  // gate is OFF for any sibling file and no test user or code lingers.
  await withServiceRole(async (tx) => {
    await tx.exec(`select public.set_beta_invite_only(false)`);
    await tx.exec(`delete from auth.users where email like 'invite-gate-%@example.test'`);
    await tx.exec(`delete from public.invite_codes where code = upper($1)`, [CODE]);
  });
  await closePool();
});

describe('beta invite gate — real trigger validates and consumes codes', () => {
  it('arms the gate and seeds a genuine 2-use code via the owner function', async () => {
    await withServiceRole(async (tx) => {
      await tx.exec(`delete from public.invite_codes where code = upper($1)`, [CODE]);
      await tx.exec(`select public.create_invite_code($1, 2, null, 'pg-invite-gate-test')`, [CODE]);
      await tx.exec(`select public.set_beta_invite_only(true)`);
    });
    const row = await usesOf(CODE);
    expect(row).toMatchObject({ uses: 0, max_uses: 2 });
  });

  it('a signup carrying the valid code is admitted AND consumes one use', async () => {
    await expect(signupInsert(CODE)).resolves.toBeTypeOf('string');
    expect((await usesOf(CODE))!.uses).toBe(1);
  });

  it('a second signup consumes the last remaining use', async () => {
    await expect(signupInsert(CODE)).resolves.toBeTypeOf('string');
    expect((await usesOf(CODE))!.uses).toBe(2);
  });

  it('a third signup is rejected once the code is exhausted (uses == max_uses)', async () => {
    await expect(signupInsert(CODE)).rejects.toThrow(/invite-only/i);
    expect((await usesOf(CODE))!.uses).toBe(2); // not incremented past the limit
  });

  it('a signup with no invite code is rejected while the gate is armed', async () => {
    await expect(signupInsert(null)).rejects.toThrow(/invite-only/i);
  });

  it('a signup with an unknown code is rejected', async () => {
    await expect(signupInsert('NOPE_NOT_A_REAL_CODE')).rejects.toThrow(/invite-only/i);
  });

  it('with the gate disabled again, an ordinary signup is admitted (fresh-DB default)', async () => {
    await withServiceRole((tx) => tx.exec(`select public.set_beta_invite_only(false)`));
    await expect(signupInsert(null)).resolves.toBeTypeOf('string');
  });
});
