import { withUser } from '@/lib/api';
import { searchCards } from '@/lib/services/pg';

export async function GET(req: Request) {
  return withUser(async ({ user }) => {
    const url = new URL(req.url);
    return {
      results: await searchCards(
        user.id,
        url.searchParams.get('q') ?? '',
        url.searchParams.get('set') ?? undefined,
        Math.min(Number(url.searchParams.get('limit') ?? 30), 100),
      ),
    };
  });
}
