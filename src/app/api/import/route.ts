import { z } from 'zod';
import { withUser } from '@/lib/api';
import { matchRows, parseRows } from '@/lib/services/import';
import { addToCollection } from '@/lib/services/collection';
import { syncMilestonesForSet } from '@/lib/services/goals';
import { RULES, limitOrThrow } from '@/lib/rateLimit';
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

    limitOrThrow(`import:${user.id}`, RULES.importCommit);

    // Imports are all-or-nothing: a half-applied spreadsheet is worse than a
    // rejected one, because the collector cannot tell which half landed.
    //
    // Milestones are deferred and recomputed once per affected set at the end.
    // Doing it per row recomputed a whole set's metrics thousands of times and
    // blocked the server for ~48s on a full-size import.
    let added = 0;
    const touchedSets = new Set<string>();

    db.transaction(() => {
      for (const r of body.rows) {
        const result = addToCollection(db, user.id, {
          cardId: r.cardId,
          variant: r.variant,
          quantity: r.quantity,
          condition: r.condition ?? 'NM',
          paidCents: r.paidCents ?? null,
          sourceNote: 'CSV import',
          deferMilestones: true,
        });
        touchedSets.add(result.setId);
        added += r.quantity;
      }
      for (const setId of touchedSets) syncMilestonesForSet(db, user.id, setId);
    })();

    return { ok: true, added, rows: body.rows.length, setsTouched: touchedSets.size };
  });
}
