import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { withIdentity, withServiceRole, closePool } from '@/lib/db/pg';
import { billingEnabled, BILLING_FLAG, stripeRequest, verifyWebhookSignature } from '@/lib/billing';
import { seedUser, dropUsers } from './fixtures';

/**
 * Billing is present and switched off.
 *
 * The valuable assertions here are the negative ones: that the flag is off by
 * default, that it stays off when half-configured, and that no code path can
 * reach Stripe or grant a subscription while it is off. The signature check is
 * tested for real because it is the thing that will matter on the day the flag
 * flips, and a webhook verifier that is only exercised in production is a
 * verifier nobody has tested.
 */

const saved = { ...process.env };

afterEach(() => {
  for (const k of [BILLING_FLAG, 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

afterAll(async () => {
  await closePool();
});

describe('the billing flag', () => {
  it('is off in this deployment', () => {
    expect(billingEnabled()).toBe(false);
  });

  it('stays off when switched on but not configured', () => {
    process.env[BILLING_FLAG] = 'true';
    expect(billingEnabled()).toBe(false);

    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    expect(billingEnabled()).toBe(false); // still no webhook secret
  });

  it('only turns on when the flag and both secrets are present', () => {
    process.env[BILLING_FLAG] = 'true';
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_x';
    expect(billingEnabled()).toBe(true);
  });

  it('is not turned on by a truthy-looking value', () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_x';
    for (const v of ['1', 'yes', 'TRUE', 'on', '']) {
      process.env[BILLING_FLAG] = v;
      expect(billingEnabled(), v).toBe(false);
    }
  });

  it('refuses to call Stripe while it is off', async () => {
    await expect(stripeRequest('customers')).rejects.toThrow(/not enabled/i);
  });
});

describe('webhook signature verification', () => {
  const secret = 'whsec_testsecret';
  const payload = '{"id":"evt_1","type":"customer.subscription.updated"}';
  const sign = (ts: number, body = payload, key = secret) =>
    `t=${ts},v1=${createHmac('sha256', key).update(`${ts}.${body}`).digest('hex')}`;

  it('accepts a correctly signed, fresh payload', () => {
    const now = Date.now();
    expect(verifyWebhookSignature(payload, sign(Math.floor(now / 1000)), secret, 300, now)).toBe(true);
  });

  it('rejects a missing or malformed header', () => {
    const now = Date.now();
    expect(verifyWebhookSignature(payload, null, secret, 300, now)).toBe(false);
    expect(verifyWebhookSignature(payload, 'garbage', secret, 300, now)).toBe(false);
    expect(verifyWebhookSignature(payload, 't=123', secret, 300, now)).toBe(false);
  });

  it('rejects a payload signed with the wrong secret', () => {
    const now = Date.now();
    const header = sign(Math.floor(now / 1000), payload, 'whsec_attacker');
    expect(verifyWebhookSignature(payload, header, secret, 300, now)).toBe(false);
  });

  it('rejects a valid signature over different bytes', () => {
    const now = Date.now();
    const header = sign(Math.floor(now / 1000), payload);
    expect(verifyWebhookSignature('{"id":"evt_2"}', header, secret, 300, now)).toBe(false);
  });

  it('rejects a replay outside the tolerance window', () => {
    const now = Date.now();
    const old = Math.floor(now / 1000) - 3600;
    expect(verifyWebhookSignature(payload, sign(old), secret, 300, now)).toBe(false);
    // …and accepts it while it is still inside the window.
    expect(verifyWebhookSignature(payload, sign(old), secret, 7200, now)).toBe(true);
  });
});

describe('billing tables are not user-writable', () => {
  it('refuses a collector granting themselves a subscription', async () => {
    const u = await seedUser('bill');
    try {
      await expect(
        withIdentity(u, (tx) =>
          tx.exec(
            `insert into public.billing_subscriptions (id, user_id, status)
             values ('sub_forged', $1::uuid, 'active')`,
            [u],
          ),
        ),
      ).rejects.toThrow();

      // And cannot read another collector's billing state, or the raw events.
      await expect(
        withIdentity(u, (tx) => tx.rows('select * from public.billing_events')),
      ).rejects.toThrow();

      await withServiceRole((tx) =>
        tx.exec(
          `insert into public.billing_subscriptions (id, user_id, status)
           values ('sub_real', $1::uuid, 'active') on conflict (id) do nothing`,
          [u],
        ),
      );
      const mine = await withIdentity(u, (tx) =>
        tx.rows<{ id: string }>('select id from public.billing_subscriptions'),
      );
      expect(mine.map((r) => r.id)).toEqual(['sub_real']);
    } finally {
      await withServiceRole((tx) =>
        tx.exec('delete from public.billing_subscriptions where id = $1', ['sub_real']),
      );
      await dropUsers(u);
    }
  });
});
