import { z } from 'zod';
import { withUser } from '@/lib/api';
import { matchRows, parseRows } from '@/lib/services/import';
import { addToCollection } from '@/lib/services/collection';
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
  return withUser(async ({ user, db }) => {
    const body = z.union([preview, commit]).parse(await req.json());

    if (body.mode === 'preview') {
      const { rows, header, recognised } = parseRows(body.csv);
      const result = matchRows(db, rows);
      return {
        ok: true,
        header,
        recognised,
        // Only the first slice is sent back for display; the totals describe
        // the whole file so the summary never under-reports what was found.
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

    // Imports are all-or-nothing: a half-applied spreadsheet is worse than a
    // rejected one, because the collector cannot tell which half landed.
    let added = 0;
    db.transaction(() => {
      for (const r of body.rows) {
        addToCollection(db, user.id, {
          cardId: r.cardId,
          variant: r.variant,
          quantity: r.quantity,
          condition: r.condition ?? 'NM',
          paidCents: r.paidCents ?? null,
          sourceNote: 'CSV import',
        });
        added += r.quantity;
      }
    })();

    return { ok: true, added, rows: body.rows.length };
  });
}
