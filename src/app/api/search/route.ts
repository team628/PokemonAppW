import { withUser } from '@/lib/api';
import { searchCards } from '@/lib/repo/catalog';

export async function GET(req: Request) {
  return withUser(({ db }) => {
    const url = new URL(req.url);
    const q = url.searchParams.get('q') ?? '';
    const setId = url.searchParams.get('set') ?? undefined;
    const limit = Number(url.searchParams.get('limit') ?? 30);
    return { results: searchCards(db, q, { setId, limit }) };
  });
}
