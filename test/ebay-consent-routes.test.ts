/**
 * The eBay consent routes over HTTP.
 *
 * The consent flow is the one place where a mistake is exploitable rather
 * than merely broken: a callback that does not check the state can be
 * replayed with somebody else's code.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp, listen, type Session } from '../src/server.ts';
import { EBayService } from '../src/ebay-service.ts';
import { EBayAdapter } from '../src/ebay.ts';
import { EBayClient } from '../src/ebay-client.ts';
import { MemoryEBayTokenStore } from '../src/ebay-store.ts';

async function withServer(
  service: EBayService | undefined,
  run: (ctx: { base: string; close: () => Promise<void>; cookie: string }) => Promise<void>,
): Promise<void> {
  const sessions: Record<string, Session> = {
    'emily-token': { authUserId: 'auth-emily', displayName: 'Emily' },
  };
  const { server } = createApp({
    verifySession: (token) => (token ? sessions[token] ?? null : null),
    sessionSecret: 'test-secret-value',
    ...(service ? { ebayService: service } : {}),
  });
  const { port, close } = await listen(server);
  try {
    await run({ base: `http://127.0.0.1:${port}`, close, cookie: 'stoop_session=emily-token' });
  } finally {
    // The server must close even when an assertion throws, or the test
    // runner waits on the open handle forever instead of reporting the
    // failure.
    await close();
  }
}

function buildService() {
  const client = new EBayClient({
    clientId: 'AppId',
    clientSecret: 'CertId',
    environment: 'sandbox',
    fetchImpl: (async () =>
      new Response(
        JSON.stringify({
          access_token: 'seller-token',
          token_type: 'Bearer',
          expires_in: 7200,
          refresh_token: 'seller-refresh',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch,
  });
  const store = new MemoryEBayTokenStore();
  const adapter = new EBayAdapter(client, { accessToken: async () => 'seller-token' }, {
    inventoryLocationId: 'inv-location-1',
    categoryId: '183050',
    fulfillmentPolicyId: 'ful-1',
    paymentPolicyId: 'pay-1',
    returnPolicyId: 'ret-1',
  });
  const service = new EBayService({
    client,
    adapter,
    tokenStore: store,
    environment: 'sandbox',
    redirectUri: 'http://127.0.0.1/api/ebay/callback',
  });
  return { service, store };
}

test('connecting sends Emily to eBay with a PKCE challenge and a state cookie', async () => {
  const { service } = buildService();
  await withServer(service, async ({ base, close, cookie }) => {
    const res = await fetch(`${base}/api/ebay/connect`, {
      headers: { cookie },
      redirect: 'manual',
    });

    assert.equal(res.status, 302);
    const location = res.headers.get('location') ?? '';
    assert.match(location, /sandbox\.ebay\.com/);
    assert.match(location, /code_challenge=/);
    assert.match(location, /code_challenge_method=S256/);

    const setCookie = res.headers.get('set-cookie') ?? '';
    assert.match(setCookie, /stoop_ebay_oauth=/);
    assert.match(setCookie, /HttpOnly/);
    await close();
  });
});

test('connecting without a configured eBay is refused', async () => {
  await withServer(undefined, async ({ base, close, cookie }) => {
    const res = await fetch(`${base}/api/ebay/connect`, { headers: { cookie } });
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: 'ebay_not_configured' });
    await close();
  });
});

test('a callback with no state cookie is refused', async () => {
  const { service } = buildService();
  await withServer(service, async ({ base, close, cookie }) => {
    const res = await fetch(`${base}/api/ebay/callback?code=the-code&state=the-state`, {
      headers: { cookie },
      redirect: 'manual',
    });

    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'ebay_callback_invalid' });
    await close();
  });
});

test('a callback whose state does not match the cookie is refused', async () => {
  const { service } = buildService();
  await withServer(service, async ({ base, close, cookie }) => {
    // Take a real connect first, so there is a genuine signed cookie.
    const connect = await fetch(`${base}/api/ebay/connect`, {
      headers: { cookie },
      redirect: 'manual',
    });
    const stateCookie = (connect.headers.get('set-cookie') ?? '').split(';')[0];

    const res = await fetch(`${base}/api/ebay/callback?code=the-code&state=a-different-state`, {
      headers: { cookie: `${cookie}; ${stateCookie}` },
      redirect: 'manual',
    });

    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'ebay_callback_invalid' });
    await close();
  });
});

test('a callback with no code is refused', async () => {
  const { service } = buildService();
  await withServer(service, async ({ base, close, cookie }) => {
    const connect = await fetch(`${base}/api/ebay/connect`, {
      headers: { cookie },
      redirect: 'manual',
    });
    const stateCookie = (connect.headers.get('set-cookie') ?? '').split(';')[0];
    const state = new URL(connect.headers.get('location') ?? '').searchParams.get('state') ?? '';

    const res = await fetch(`${base}/api/ebay/callback?state=${state}`, {
      headers: { cookie: `${cookie}; ${stateCookie}` },
      redirect: 'manual',
    });

    assert.equal(res.status, 400);
    await close();
  });
});

test('a callback with a matching state is accepted and the tokens are kept', async () => {
  const { service, store } = buildService();
  await withServer(service, async ({ base, close, cookie }) => {
    const connect = await fetch(`${base}/api/ebay/connect`, {
      headers: { cookie },
      redirect: 'manual',
    });
    const stateCookie = (connect.headers.get('set-cookie') ?? '').split(';')[0];
    const state = new URL(connect.headers.get('location') ?? '').searchParams.get('state') ?? '';

    const res = await fetch(`${base}/api/ebay/callback?code=the-code&state=${state}`, {
      headers: { cookie: `${cookie}; ${stateCookie}` },
      redirect: 'manual',
    });

    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/');

    const stored = await store.get('seller_auth-emily', 'sandbox');
    assert.ok(stored, 'the tokens are kept against the seller');
    assert.equal(stored.accessToken, 'seller-token');
    await close();
  });
});

test('the consent routes need a session like everything else', async () => {
  const { service } = buildService();
  await withServer(service, async ({ base, close }) => {
    const connect = await fetch(`${base}/api/ebay/connect`, { redirect: 'manual' });
    assert.equal(connect.status, 401);
    await close();
  });
});
