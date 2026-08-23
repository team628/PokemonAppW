import { z } from 'zod';
import { goalModeSchema, withUser } from '@/lib/api';
import { addGoal, myGoals } from '@/lib/services/pg';

const body = z.object({ setId: z.string().min(1), mode: goalModeSchema });

export async function POST(req: Request) {
  return withUser(async ({ user }) => {
    const { setId, mode } = body.parse(await req.json());
    return { ok: true, goalId: await addGoal(user.id, setId, mode) };
  });
}

export async function GET() {
  return withUser(async ({ user }) => ({
    goals: (await myGoals(user.id)).map((g) => ({
      goalId: g.goalId,
      setId: g.setId,
      setName: g.setName,
      mode: g.mode,
      percent: g.percent,
      needCents: g.needCents,
      missingCount: g.missingCount,
    })),
  }));
}
