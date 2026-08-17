import { z } from 'zod';
import { limitOrThrow, withUser } from '@/lib/api';
import { matchRows, parseRows } from '@/lib/services/import';
import { withIdentity } from '@/lib/db/pg';
import { addWithin } from '@/lib/services/pg/collection';
import { syncMilestonesForSet, RULES } from '@/lib/services/pg';
import { isVariant } from '@/lib/catalog/variants';
import { CONDITIONS } from '@/lib/domain/conditions';

const preview = z.object({ mode: z.literal('preview'), csv: z.string().max(4_000_000) });

const commit = z.object({
  mode: z.literal('commit'),
  rows: z
    .array(
      z.object({
        cardId: z.string().min(1),
        variant: z.string().refine(isVariant, 'unknown printing'),
        quantity: z.number().int().min(1).max(999),
        condition: z.enum(CONDITIONS).optional(),
        paidCents: z.number().int().min(0).nullable().optional(),
      }),
    )
    .max(20_000),
});

export async function POST(req: Request) {
  return withUser(async ({ user }) => {
    const body = z.union([preview, commit]).parse(await req.json());

    if (body.mode === 'preview') {
      const { rows, header, recognised } = parseRows(body.csv);
      const result = await matchRows(user.id, rows);
      return {
        ok: true,
        header,
        recognised,
        preview: { ...result, rows: result.rows.slice(0, 400) },
        allRows: result.rows
          .filter((r) => r.confidence === 'exact')
          .map((r) => ({
            cardId: r.cardId!,
            variant: r.resolvedVariant!,
            quantity: r.quantity,
            condition: r.condition,
            paidCents: r.paidCents,
          })),
      };
    }

    await limitOrThrow(`import:${user.id}`, RULES.importCommit);

    // One transaction: a half-applied spreadsheet is worse than a rejected one,
    // because the collector cannot tell which half landed. Milestones are
    // deferred to one pass per affected set rather than recomputed per row.
    let added = 0;
    const touched = new Set<string>();

    await withIdentity(user.id, async (tx) => {
      for (const r of body.rows) {
        const res = await addWithin(tx, {
          cardId: r.cardId,
          variant: r.variant,
          quantity: r.quantity,
          condition: r.condition ?? 'NM',
          paidCents: r.paidCents ?? null,
          sourceNote: 'CSV import',
        });
        touched.add(res.set_id);
        added += r.quantity;
      }
    });

    for (const setId of touched) await syncMilestonesForSet(user.id, setId);

    return { ok: true, added, rows: body.rows.length, setsTouched: touched.size };
  });
}
