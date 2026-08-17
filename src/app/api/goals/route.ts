import { z } from 'zod';
import { goalModeSchema, withUser } from '@/lib/api';
import { addGoal, goalViews } from '@/lib/services/goals';

const body = z.object({ setId: z.string().min(1), mode: goalModeSchema });

export async function POST(req: Request) {
  return withUser(async ({ user, db }) => {
    const { setId, mode } = body.parse(await req.json());
    const goal = addGoal(db, user.id, setId, mode);
    return { ok: true, goalId: goal.id };
  });
}

export async function GET() {
  return withUser(({ user, db }) => ({
    goals: goalViews(db, user.id).map((v) => ({
      goalId: v.goal.id,
      setId: v.set.id,
      setName: v.set.name,
      mode: v.goal.mode,
      percent: v.metrics.percent,
      needCents: v.metrics.needCents,
      missingCount: v.metrics.missingCount,
    })),
  }));
}
