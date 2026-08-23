import { withUser } from '@/lib/api';
import { markMilestonesSeen } from '@/lib/services/pg';

export async function POST() {
  return withUser(async ({ user }) => {
    await markMilestonesSeen(user.id);
    return { ok: true };
  });
}
