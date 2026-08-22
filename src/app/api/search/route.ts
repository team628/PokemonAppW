import { withUser } from '@/lib/api';
import { searchCards } from '@/lib/services/pg';

export async function GET(req: Request) {
  return withUser(async ({ user }) => {
    const url = new URL(req.url);
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 30) || 30, 1), 100);
    const offset = Math.max(Number(url.searchParams.get('offset') ?? 0) || 0, 0);
    const rows = (await searchCards(
      user.id,
      url.searchParams.get('q') ?? '',
      url.searchParams.get('set') ?? undefined,
      limit,
      offset,
    )) as Array<Record<string, unknown> & { total_count?: number }>;
    // total_count is the same on every row; strip it from the item shape and
    // surface pagination metadata so the UI can offer "show more printings".
    const total = Number(rows[0]?.total_count ?? rows.length);
    const results = rows.map(({ total_count: _t, ...card }) => card);
    return { results, total, offset, limit, hasMore: offset + results.length < total };
  });
}
