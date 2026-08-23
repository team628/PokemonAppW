import { NextResponse } from 'next/server';
import { billingEnabled, verifyWebhookSignature } from '@/lib/billing';
import { withServiceRole } from '@/lib/db/pg';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Stripe webhook receiver.
 *
 * While billing is off this route is a 404 — indistinguishable from a path that
 * does not exist, which is what an unlaunched endpoint should look like from
 * outside. Nothing is parsed, nothing is written, and no signature is checked,
 * because there is nothing to check it against.
 *
 * When billing is switched on the request is verified before it is read as
 * anything but bytes, and the event id is claimed once: Stripe retries
 * deliveries, and a subscription change applied twice is a billing bug.
 */
export async function POST(req: Request) {
  if (!billingEnabled()) {
    return new NextResponse('Not found', { status: 404 });
  }

  const payload = await req.text();
  const ok = verifyWebhookSignature(
    payload,
    req.headers.get('stripe-signature'),
    process.env.STRIPE_WEBHOOK_SECRET!,
  );
  if (!ok) return NextResponse.json({ error: 'invalid signature' }, { status: 400 });

  const event = JSON.parse(payload) as { id?: string; type?: string; data?: unknown };
  if (!event.id || !event.type) {
    return NextResponse.json({ error: 'malformed event' }, { status: 400 });
  }

  const fresh = await withServiceRole(async (tx) => {
    const n = await tx.exec(
      `insert into public.billing_events (id, type, payload) values ($1, $2, $3::jsonb)
       on conflict (id) do nothing`,
      [event.id, event.type, payload],
    );
    return n > 0;
  });

  // A duplicate delivery is acknowledged, not reprocessed: Stripe only needs a
  // 2xx to stop retrying.
  if (!fresh) return NextResponse.json({ received: true, duplicate: true });

  // Subscription state handling lands here when a plan actually exists. It is
  // deliberately absent rather than stubbed: there is no plan to record.
  return NextResponse.json({ received: true });
}
