import { withUser } from '@/lib/api';
import { markMilestonesSeen } from '@/lib/services/goals';

export async function POST() {
  return withUser(({ user, db }) => {
    markMilestonesSeen(db, user.id);
    return { ok: true };
  });
}
