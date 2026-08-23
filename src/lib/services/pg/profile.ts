import { withIdentity } from '../../db/pg';

/**
 * Profile and public sharing.
 *
 * Sharing is opt-in at the database layer: `profiles.share_public` defaults to
 * false and the `profiles_public_read` policy is what makes a page visible.
 * A private handle is therefore not merely hidden by a page component — it is
 * unreadable, which is why the public route can return a plain 404 and give
 * nothing away about whether the collector exists.
 */

export interface Profile {
  id: string;
  handle: string;
  display_name: string;
  avatar_color: string;
  share_public: boolean;
  created_at: string;
}

export async function myProfile(userId: string): Promise<Profile | undefined> {
  return withIdentity(userId, (tx) =>
    tx.one<Profile>('select * from public.profiles where id = $1::uuid', [userId]),
  );
}

export async function setSharePublic(userId: string, isPublic: boolean): Promise<void> {
  await withIdentity(userId, (tx) =>
    tx.exec('update public.profiles set share_public = $1, updated_at = now() where id = $2::uuid', [
      isPublic,
      userId,
    ]),
  );
}

export interface PublicCollection {
  profile: Profile;
  goals: {
    goalId: string;
    setId: string;
    setName: string;
    mode: string;
    ownedCount: number;
    requiredCount: number;
    haveCents: number;
    needCents: number;
    completeCents: number;
    percent: number;
    completedAt: string | null;
  }[];
  totalCards: number;
  setsFinished: number;
}

/**
 * A public share page, read as an anonymous visitor.
 *
 * Runs under the `anon` role, so RLS returns nothing at all unless the
 * collector opted in — the caller gets `null` for a private or non-existent
 * handle and cannot tell the two apart.
 *
 * Progress comes from the snapshot on set_goals rather than goal_metrics, which
 * is scoped to the calling user and would return zeroes here. The snapshot is
 * refreshed whenever the collection changes.
 */
export async function publicCollection(handle: string): Promise<PublicCollection | null> {
  return withIdentity(null, async (tx) => {
    const profile = await tx.one<Profile>(
      'select * from public.profiles where handle = $1::citext and share_public',
      [handle],
    );
    if (!profile) return null;

    const goals = await tx.rows<{
      goal_id: string; set_id: string; set_name: string; mode: string;
      owned_count: number; required_count: number; have_cents: number;
      need_cents: number; complete_cents: number; completed_at: string | null;
    }>(
      `select g.id as goal_id, g.set_id, s.name as set_name, g.mode::text,
              g.owned_count, g.required_count, g.have_cents, g.need_cents,
              g.complete_cents, g.completed_at::text
       from public.set_goals g
       join public.sets s on s.id = g.set_id
       where g.user_id = $1::uuid
       order by case when g.required_count > 0 then g.owned_count::numeric / g.required_count else 0 end desc`,
      [profile.id],
    );

    const totals = await tx.one<{ cards: number }>(
      'select coalesce(sum(quantity), 0)::int as cards from public.collection_items where user_id = $1::uuid',
      [profile.id],
    );

    return {
      profile,
      goals: goals.map((g) => ({
        goalId: g.goal_id,
        setId: g.set_id,
        setName: g.set_name,
        mode: g.mode,
        ownedCount: g.owned_count,
        requiredCount: g.required_count,
        haveCents: g.have_cents,
        needCents: g.need_cents,
        completeCents: g.complete_cents,
        percent: g.required_count ? g.owned_count / g.required_count : 0,
        completedAt: g.completed_at,
      })),
      totalCards: totals?.cards ?? 0,
      setsFinished: goals.filter((g) => g.completed_at !== null).length,
    };
  });
}

export interface PublicMissingCard {
  cardId: string;
  variant: string;
  number: string;
  name: string;
  imageSmall: string | null;
  marketCents: number | null;
}

/**
 * The "still hunting" rail on a shared page.
 *
 * Reads through `public_goal_missing`, which re-checks `share_public` itself
 * and returns card identity only — never quantity, condition or what was paid.
 * Called as an anonymous visitor, so a private handle yields an empty list by
 * the same route a signed-out browser would take.
 */
export async function publicMissing(
  handle: string,
  setId: string,
  mode: string,
  limit = 20,
): Promise<PublicMissingCard[]> {
  const rows = await withIdentity(null, (tx) =>
    tx.rows<{
      card_id: string; variant: string; number: string;
      name: string; image_small: string | null; market_cents: number | null;
    }>('select * from public.public_goal_missing($1::citext, $2, $3::public.goal_mode, $4)', [
      handle,
      setId,
      mode,
      limit,
    ]),
  );
  return rows.map((r) => ({
    cardId: r.card_id,
    variant: r.variant,
    number: r.number,
    name: r.name,
    imageSmall: r.image_small,
    marketCents: r.market_cents,
  }));
}
