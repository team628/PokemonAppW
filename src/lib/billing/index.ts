import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Billing, behind a flag that is off.
 *
 * SetValue does not charge anyone today. This module exists so that turning
 * payments on is a configuration change against tested code rather than a
 * scramble, and so the shape of the integration is visible for review now —
 * but every entry point below refuses to do anything while the flag is off.
 *
 * What is deliberately NOT here: no price ids, no plan names, no "Upgrade"
 * surface, no copy promising a paid tier. Advertising a product that cannot be
 * bought is the same class of dishonesty as quoting a price nobody quoted.
 */

export const BILLING_FLAG = 'SETVALUE_BILLING_ENABLED';

/**
 * Billing is on only when it is explicitly switched on *and* the secrets it
 * needs are actually present. A half-configured deployment stays off rather
 * than failing at the moment a collector tries to pay.
 */
export function billingEnabled(): boolean {
  return (
    process.env[BILLING_FLAG] === 'true' &&
    !!process.env.STRIPE_SECRET_KEY &&
    !!process.env.STRIPE_WEBHOOK_SECRET
  );
}

export class BillingDisabledError extends Error {
  constructor() {
    super('Billing is not enabled on this deployment.');
    this.name = 'BillingDisabledError';
  }
}

function requireEnabled(): void {
  if (!billingEnabled()) throw new BillingDisabledError();
}

/**
 * Verifies a Stripe webhook signature.
 *
 * Implemented against Stripe's documented `Stripe-Signature` scheme —
 * `t=<unix>,v1=<hex hmac of "t.payload">` keyed with the endpoint secret —
 * rather than pulling in the Stripe SDK for a feature that is switched off.
 * When billing is turned on, this is the check that decides whether a request
 * claiming to be from Stripe is treated as one.
 *
 * The timestamp tolerance is what stops a captured payload being replayed
 * later; the constant-time compare is what stops the signature being guessed a
 * byte at a time.
 */
export function verifyWebhookSignature(
  payload: string,
  header: string | null,
  secret: string,
  toleranceSeconds = 300,
  now = Date.now(),
): boolean {
  if (!header) return false;

  let timestamp = '';
  const candidates: string[] = [];
  for (const part of header.split(',')) {
    const [k, v] = part.split('=', 2);
    if (k === 't' && v) timestamp = v;
    if (k === 'v1' && v) candidates.push(v);
  }
  if (!timestamp || candidates.length === 0) return false;

  const age = Math.abs(now / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > toleranceSeconds) return false;

  const expected = createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest();
  return candidates.some((c) => {
    let given: Buffer;
    try {
      given = Buffer.from(c, 'hex');
    } catch {
      return false;
    }
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

/**
 * A Stripe API call, without the SDK.
 *
 * Kept to the handful of calls a subscription flow needs. Refuses outright
 * while the flag is off, so an accidental import cannot start charging anyone.
 */
export async function stripeRequest(
  path: string,
  init: { method?: string; body?: Record<string, string> } = {},
): Promise<unknown> {
  requireEnabled();
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: init.method ?? 'POST',
    headers: {
      Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      // Pinning the version means Stripe changing its default cannot change
      // the shape of what arrives here.
      'Stripe-Version': '2025-03-31.basil',
    },
    body: init.body ? new URLSearchParams(init.body).toString() : undefined,
  });
  if (!res.ok) throw new Error(`stripe ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}
