import { getDb, newId, nowIso, type DB } from '../db';
import { primaryVariantMap, setRequirements, getSet, type SetRow } from '../repo/catalog';
import {
  computeGoal,
  milestonesFor,
  ownedIndex,
  requirementsForMode,
  type GoalMetrics,
  type GoalMode,
  type MilestoneKind,
  type OwnedSlot,
} from '../domain/goals';
import type { Variant } from '../catalog/variants';

export interface GoalRow {
  id: string;
  user_id: string;
  set_id: string;
  mode: GoalMode;
  pinned: number;
  created_at: string;
  completed_at: string | null;
}

export interface GoalView {
  goal: GoalRow;
  set: SetRow;
  metrics: GoalMetrics;
}

export function ownedSlotsForSet(db: DB, userId: string, setId: string): OwnedSlot[] {
  const rows = db
    .prepare(
      `SELECT ci.card_id, ci.variant, SUM(ci.quantity) AS qty
       FROM collection_items ci JOIN cards c ON c.id = ci.card_id
       WHERE ci.user_id = ? AND c.set_id = ?
       GROUP BY ci.card_id, ci.variant`,
    )
    .all(userId, setId) as { card_id: string; variant: string; qty: number }[];
  return rows.map((r) => ({ cardId: r.card_id, variant: r.variant as Variant, quantity: r.qty }));
}

export function metricsForSet(
  db: DB,
  userId: string,
  setId: string,
  mode: GoalMode,
): GoalMetrics {
  const all = setRequirements(db, setId);
  const primaries = primaryVariantMap(db, setId);
  const required = requirementsForMode(all, mode, primaries);
  return computeGoal(mode, required, ownedIndex(ownedSlotsForSet(db, userId, setId)));
}

export function listGoals(db: DB, userId: string): GoalRow[] {
  return db
    .prepare('SELECT * FROM set_goals WHERE user_id = ? ORDER BY pinned DESC, created_at')
    .all(userId) as GoalRow[];
}

export function goalViews(db: DB, userId: string): GoalView[] {
  const goals = listGoals(db, userId);
  return goals
    .map((goal) => {
      const set = getSet(db, goal.set_id);
      if (!set) return null;
      return { goal, set, metrics: metricsForSet(db, userId, goal.set_id, goal.mode) };
    })
    .filter((v): v is GoalView => v !== null);
}

export function getGoal(db: DB, userId: string, goalId: string): GoalRow | undefined {
  return db
    .prepare('SELECT * FROM set_goals WHERE id = ? AND user_id = ?')
    .get(goalId, userId) as GoalRow | undefined;
}

export function addGoal(db: DB, userId: string, setId: string, mode: GoalMode): GoalRow {
  const existing = db
    .prepare('SELECT * FROM set_goals WHERE user_id = ? AND set_id = ? AND mode = ?')
    .get(userId, setId, mode) as GoalRow | undefined;
  if (existing) return existing;

  const row: GoalRow = {
    id: newId('goal'),
    user_id: userId,
    set_id: setId,
    mode,
    pinned: 0,
    created_at: nowIso(),
    completed_at: null,
  };
  db.prepare(
    'INSERT INTO set_goals (id, user_id, set_id, mode, pinned, created_at) VALUES (?, ?, ?, ?, 0, ?)',
  ).run(row.id, row.user_id, row.set_id, row.mode, row.created_at);
  logEvent(db, userId, 'goal_added', { setId, payload: { mode } });
  syncMilestones(db, userId, row);
  return row;
}

export function removeGoal(db: DB, userId: string, goalId: string): void {
  db.prepare('DELETE FROM set_goals WHERE id = ? AND user_id = ?').run(goalId, userId);
  db.prepare('DELETE FROM milestones WHERE user_id = ? AND goal_id = ?').run(userId, goalId);
}

export function togglePin(db: DB, userId: string, goalId: string): void {
  db.prepare(
    'UPDATE set_goals SET pinned = CASE pinned WHEN 1 THEN 0 ELSE 1 END WHERE id = ? AND user_id = ?',
  ).run(goalId, userId);
}

// ------------------------------------------------------------- milestones ---

export interface MilestoneRow {
  user_id: string;
  goal_id: string;
  kind: MilestoneKind;
  achieved_at: string;
  payload: string | null;
  seen: number;
}

/**
 * Records any milestone this goal has newly reached.
 *
 * Milestones are write-once: a set that dips back below 50% because a card was
 * sold does not re-fire "Halfway" when it climbs again. The moment happened, it
 * is part of the collection's history, and re-congratulating someone for it
 * would cheapen the one that matters.
 */
export function syncMilestones(db: DB, userId: string, goal: GoalRow): MilestoneRow[] {
  const metrics = metricsForSet(db, userId, goal.set_id, goal.mode);
  const reached = milestonesFor(metrics);
  const already = new Set(
    (
      db
        .prepare('SELECT kind FROM milestones WHERE user_id = ? AND goal_id = ?')
        .all(userId, goal.id) as { kind: MilestoneKind }[]
    ).map((r) => r.kind),
  );

  const fresh: MilestoneRow[] = [];
  const insert = db.prepare(
    `INSERT INTO milestones (user_id, goal_id, kind, achieved_at, payload, seen)
     VALUES (?, ?, ?, ?, ?, 0) ON CONFLICT DO NOTHING`,
  );

  for (const kind of reached) {
    if (already.has(kind)) continue;
    const payload = JSON.stringify({
      setId: goal.set_id,
      mode: goal.mode,
      percent: metrics.percent,
      ownedCount: metrics.ownedCount,
      requiredCount: metrics.requiredCount,
      completeCents: metrics.completeCents,
    });
    const at = nowIso();
    insert.run(userId, goal.id, kind, at, payload);
    fresh.push({ user_id: userId, goal_id: goal.id, kind, achieved_at: at, payload, seen: 0 });
    logEvent(db, userId, `milestone:${kind}`, { setId: goal.set_id, payload: JSON.parse(payload) });
  }

  if (metrics.requiredCount > 0 && metrics.missingCount === 0 && !goal.completed_at) {
    db.prepare('UPDATE set_goals SET completed_at = ? WHERE id = ?').run(nowIso(), goal.id);
  }
  return fresh;
}

/** Re-checks every goal that covers a set the user just changed. */
export function syncMilestonesForSet(db: DB, userId: string, setId: string): MilestoneRow[] {
  const goals = db
    .prepare('SELECT * FROM set_goals WHERE user_id = ? AND set_id = ?')
    .all(userId, setId) as GoalRow[];
  return goals.flatMap((g) => syncMilestones(db, userId, g));
}

export function unseenMilestones(db: DB, userId: string): MilestoneRow[] {
  return db
    .prepare(
      'SELECT * FROM milestones WHERE user_id = ? AND seen = 0 ORDER BY achieved_at DESC LIMIT 5',
    )
    .all(userId) as MilestoneRow[];
}

export function markMilestonesSeen(db: DB, userId: string): void {
  db.prepare('UPDATE milestones SET seen = 1 WHERE user_id = ?').run(userId);
}

// ----------------------------------------------------------------- events ---

export function logEvent(
  db: DB,
  userId: string,
  type: string,
  opts: { setId?: string; cardId?: string; payload?: unknown } = {},
): void {
  db.prepare(
    'INSERT INTO events (id, user_id, type, set_id, card_id, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(
    newId('evt'),
    userId,
    type,
    opts.setId ?? null,
    opts.cardId ?? null,
    opts.payload === undefined ? null : JSON.stringify(opts.payload),
    nowIso(),
  );
}

export function db(): DB {
  return getDb();
}
