import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AUTH_STATE_COOKIE,
  SESSION_COOKIE,
  SessionStore,
  decodeLoginState,
  encodeLoginState,
  hashToken,
  newSessionToken,
  parseCookies,
  serializeCookie,
} from '../src/session.ts';

const secret = 'test-secret-value';

test('cookies parse and round-trip', () => {
  const header = 'a=1; stoop_session=abc%2Fdef; b=2';
  const cookies = parseCookies(header);
  assert.equal(cookies.a, '1');
  assert.equal(cookies.stoop_session, 'abc/def');
  assert.deepEqual(parseCookies(undefined), {});
});

test('the session cookie is HttpOnly, Secure, SameSite=Lax and scoped to /', () => {
  const cookie = serializeCookie(SESSION_COOKIE, 'token-value', { maxAgeSeconds: 600 });
  assert.match(cookie, /^stoop_session=token-value;/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /Max-Age=600/);
});

test('tokens are stored hashed, never in the clear', () => {
  const token = newSessionToken();
  const hash = hashToken(token);
  assert.equal(hash.length, 64);
  assert.ok(!hash.includes(token));
  assert.notEqual(hash, newSessionToken());
});

test('the login state cookie is signed, tamper-proof and short-lived', () => {
  const payload = { state: 'st', nonce: 'no', verifier: 'verifier', ts: Date.now() };
  const encoded = encodeLoginState(payload, secret);
  const decoded = decodeLoginState(encoded, secret);
  assert.equal(decoded?.state, 'st');
  assert.equal(decoded?.nonce, 'no');

  // Tampered
  assert.equal(decodeLoginState(`${encoded}x`, secret), null);
  assert.equal(decodeLoginState(encoded, 'another-secret'), null);
  // Expired
  const stale = encodeLoginState({ ...payload, ts: Date.now() - 11 * 60 * 1000 }, secret);
  assert.equal(decodeLoginState(stale, secret), null);
  assert.equal(decodeLoginState(undefined, secret), null);
  assert.equal(AUTH_STATE_COOKIE, 'stoop_login');
});

/** Minimal stand-in for pg: enough to exercise the session store's logic. */
function fakePool() {
  const rows: Array<Record<string, unknown>> = [];
  return {
    rows,
    async query(sql: string, params: unknown[] = []) {
      if (sql.includes('INSERT INTO sessions')) {
        rows.push({
          token_hash: params[0],
          auth_user_id: params[1],
          display_name: params[2],
          expires_at: new Date(params[3] as string),
        });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('SELECT token_hash')) {
        return {
          rows: rows.filter((row) => new Date(row.expires_at as Date).getTime() > Date.now()),
          rowCount: rows.length,
        };
      }
      if (sql.includes('DELETE FROM sessions')) {
        const index = rows.findIndex((row) => row.token_hash === params[0]);
        if (index >= 0) rows.splice(index, 1);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

test('the session store issues, verifies and revokes', async () => {
  const pool = fakePool();
  const store = new SessionStore(pool as never, 60);
  const { token } = await store.create('auth-uuid-1', 'Emily');

  assert.equal(store.verify(token)?.authUserId, 'auth-uuid-1');
  assert.equal(store.verify(token)?.displayName, 'Emily');
  assert.equal(store.verify('not-a-token'), null);
  assert.equal(store.verify(null), null);

  // The plaintext token is never stored.
  assert.equal(pool.rows.some((row) => row.token_hash === token), false);

  await store.revoke(token);
  assert.equal(store.verify(token), null);
});

test('a session restored from the database still verifies', async () => {
  const pool = fakePool();
  const first = new SessionStore(pool as never, 60);
  const { token } = await first.create('auth-uuid-2', 'Emily');

  const restarted = new SessionStore(pool as never, 60);
  const restored = await restarted.load();
  assert.equal(restored, 1);
  assert.equal(restarted.verify(token)?.authUserId, 'auth-uuid-2');
});
