import { scryptSync, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { cookies } from 'next/headers';
import { getDb, newId, nowIso, type DB } from './db';

/**
 * Session auth with no third-party dependency: scrypt password hashing and
 * opaque random session tokens stored only as SHA-256 digests, so a database
 * leak does not hand out live sessions.
 */

export const SESSION_COOKIE = 'sv_session';
const SESSION_DAYS = 60;

export interface User {
  id: string;
  email: string;
  handle: string;
  display_name: string;
  avatar_color: string;
  created_at: string;
  share_public: number;
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, keyHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !keyHex) return false;
  const key = scryptSync(password, Buffer.from(saltHex, 'hex'), 64);
  const expected = Buffer.from(keyHex, 'hex');
  return key.length === expected.length && timingSafeEqual(key, expected);
}

const digest = (token: string) => createHash('sha256').update(token).digest('hex');

export function createSession(db: DB, userId: string): { token: string; expiresAt: Date } {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  db.prepare(
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
  ).run(digest(token), userId, nowIso(), expiresAt.toISOString());
  return { token, expiresAt };
}

export function destroySession(db: DB, token: string): void {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(digest(token));
}

export function userForToken(db: DB, token: string | undefined): User | null {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
    )
    .get(digest(token), nowIso()) as User | undefined;
  return row ?? null;
}

/** Server-component / route-handler accessor. */
export async function currentUser(): Promise<User | null> {
  const jar = await cookies();
  return userForToken(getDb(), jar.get(SESSION_COOKIE)?.value);
}

export async function requireUser(): Promise<User> {
  const u = await currentUser();
  if (!u) throw new AuthError();
  return u;
}

export class AuthError extends Error {
  constructor() {
    super('Not signed in');
    this.name = 'AuthError';
  }
}

const HANDLE_RE = /^[a-z0-9_]{3,24}$/;

export function normalizeHandle(input: string): string {
  return input.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 24);
}

export interface CreateUserInput {
  email: string;
  password: string;
  displayName: string;
  handle?: string;
}

export function createUser(db: DB, input: CreateUserInput): User {
  const email = input.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Enter a valid email address.');
  if (input.password.length < 8) throw new Error('Password must be at least 8 characters.');

  const display = input.displayName.trim() || email.split('@')[0]!;
  let handle = normalizeHandle(input.handle || display);
  if (!HANDLE_RE.test(handle)) handle = `collector_${randomBytes(3).toString('hex')}`;

  const taken = db.prepare('SELECT 1 FROM users WHERE handle = ?').get(handle);
  if (taken) handle = `${handle.slice(0, 17)}_${randomBytes(2).toString('hex')}`;

  const existing = db.prepare('SELECT 1 FROM users WHERE email = ?').get(email);
  if (existing) throw new Error('An account with that email already exists.');

  const palette = ['#2DD4A7', '#FF8A3D', '#FFC93C', '#7C9CFF', '#F472B6', '#A78BFA'];
  const user: User = {
    id: newId('usr'),
    email,
    handle,
    display_name: display,
    avatar_color: palette[Math.floor(Math.random() * palette.length)]!,
    created_at: nowIso(),
    share_public: 1,
  };
  db.prepare(
    `INSERT INTO users (id, email, handle, display_name, password_hash, avatar_color, created_at, share_public)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
  ).run(user.id, user.email, user.handle, user.display_name, hashPassword(input.password), user.avatar_color, user.created_at);
  return user;
}

export function authenticate(db: DB, email: string, password: string): User | null {
  const row = db
    .prepare('SELECT * FROM users WHERE email = ?')
    .get(email.trim().toLowerCase()) as (User & { password_hash: string }) | undefined;
  if (!row || !verifyPassword(password, row.password_hash)) return null;
  const { password_hash: _ignored, ...user } = row;
  return user;
}
