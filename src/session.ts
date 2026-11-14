/**
 * Stoop — the app's own session.
 *
 * PHATT ID (Authentik) authenticates the person; the app keeps its own short
 * session and throws the tokens away. The browser holds an opaque random
 * token; the server stores only its SHA-256 hash, so a database dump does not
 * hand anyone a live session.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';

export const SESSION_COOKIE = 'stoop_session';
export const AUTH_STATE_COOKIE = 'stoop_login';

export interface Session {
  authUserId: string;
  displayName: string;
}

export interface SessionRecord extends Session {
  expiresAt: Date;
}

/** A fresh, unguessable session token. */
export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Tokens are stored hashed. The plaintext lives only in the cookie. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

export function serializeCookie(
  name: string,
  value: string,
  options: { maxAgeSeconds?: number; path?: string; secure?: boolean; httpOnly?: boolean } = {},
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path ?? '/'}`);
  if (options.httpOnly !== false) parts.push('HttpOnly');
  if (options.secure !== false) parts.push('Secure');
  parts.push('SameSite=Lax');
  if (typeof options.maxAgeSeconds === 'number') {
    parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`);
  }
  return parts.join('; ');
}

/**
 * The short-lived cookie that carries the login attempt across the redirect to
 * PHATT ID: state, nonce and the PKCE verifier. Signed, so it cannot be
 * forged, and it dies in ten minutes.
 */
export interface LoginState {
  state: string;
  nonce: string;
  verifier: string;
  ts: number;
}

export function encodeLoginState(payload: LoginState, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function decodeLoginState(value: string | undefined, secret: string, maxAgeMs = 10 * 60 * 1000): LoginState | null {
  if (!value) return null;
  const [body, mac] = value.split('.');
  if (!body || !mac) return null;
  const expected = createHmac('sha256', secret).update(body).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(mac, 'base64url');
  } catch {
    return null;
  }
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
  let payload: LoginState;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload.ts !== 'number') return null;
  if (Date.now() - payload.ts > maxAgeMs) return null;
  return payload;
}

/**
 * Session store: Postgres for durability, memory for the request path.
 *
 * The HTTP layer verifies a session synchronously on every request, so the
 * authoritative rows live in Postgres and the process keeps a cache of the
 * live ones.
 */
export class SessionStore {
  private readonly cache = new Map<string, SessionRecord>();

  private readonly pool: Pool;
  private readonly ttlMinutes: number;

  constructor(pool: Pool, ttlMinutes = 480) {
    this.pool = pool;
    this.ttlMinutes = ttlMinutes;
  }

  /** Hydrate the cache from the database (survives an app restart). */
  async load(): Promise<number> {
    const result = await this.pool.query(
      `SELECT token_hash, auth_user_id, display_name, expires_at
         FROM sessions
        WHERE expires_at > now()`,
    );
    this.cache.clear();
    for (const row of result.rows) {
      this.cache.set(row.token_hash as string, {
        authUserId: row.auth_user_id as string,
        displayName: row.display_name as string,
        expiresAt: new Date(row.expires_at as string),
      });
    }
    return this.cache.size;
  }

  async create(authUserId: string, displayName: string): Promise<{ token: string; record: SessionRecord }> {
    const token = newSessionToken();
    const hash = hashToken(token);
    const expiresAt = new Date(Date.now() + this.ttlMinutes * 60 * 1000);
    await this.pool.query(
      `INSERT INTO sessions (token_hash, auth_user_id, display_name, expires_at)
            VALUES ($1, $2, $3, $4)`,
      [hash, authUserId, displayName, expiresAt.toISOString()],
    );
    const record: SessionRecord = { authUserId, displayName, expiresAt };
    this.cache.set(hash, record);
    return { token, record };
  }

  /** Synchronous verification — the request path cannot await. */
  verify(token: string | null | undefined): Session | null {
    if (!token) return null;
    const record = this.cache.get(hashToken(token));
    if (!record) return null;
    if (record.expiresAt.getTime() <= Date.now()) {
      this.cache.delete(hashToken(token));
      return null;
    }
    return { authUserId: record.authUserId, displayName: record.displayName };
  }

  async revoke(token: string): Promise<void> {
    const hash = hashToken(token);
    this.cache.delete(hash);
    await this.pool.query(`DELETE FROM sessions WHERE token_hash = $1`, [hash]);
  }

  /** Drop expired rows. Called periodically; cheap. */
  async prune(): Promise<number> {
    const result = await this.pool.query(`DELETE FROM sessions WHERE expires_at <= now()`);
    return result.rowCount ?? 0;
  }

  get size(): number {
    return this.cache.size;
  }
}
