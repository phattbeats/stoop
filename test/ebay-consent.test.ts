/**
 * The eBay consent flow.
 *
 * Emily connects her own eBay account. The app sends her to eBay's screen
 * and eBay sends her back with a code; the app exchanges it and keeps the
 * tokens. Nothing here consents for her.
 *
 * The things that break on day one:
 *   * the state has to come back unchanged, or a callback can be replayed
 *     with somebody else's code;
 *   * the tokens are per environment, or a sandbox token publishes into the
 *     wrong store;
 *   * a refresh token that is about to expire has to be refreshed, and one
 *     that has expired has to say so instead of failing obscurely.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EBayService } from '../src/ebay-service.ts';
import { EBayAdapter } from '../src/ebay.ts';
import { EBayClient, EBayPolicyError } from '../src/ebay-client.ts';
import { EBayTokenManager, MemoryEBayTokenStore } from '../src/ebay-store.ts';

function fakeFetch(
  handler: (call: { url: string; method: string; body: string }) => { status?: number; body?: unknown },
) {
  const calls: { url: string; method: string; body: string }[] = [];
  const impl = (async (url: string, init: RequestInit = {}) => {
    calls.push({
      url: String(url),
      method: init.method ?? 'GET',
      body: String(init.body ?? ''),
    });
    const result = handler(calls[calls.length - 1]);
    return new Response(JSON.stringify(result.body ?? {}), {
      status: result.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const tokenResponse = {
  access_token: 'seller-token',
  token_type: 'Bearer',
  expires_in: 7200,
  refresh_token: 'seller-refresh',
};

function build(
  fetchImpl: typeof fetch,
  environment: 'sandbox' | 'production' = 'sandbox',
) {
  const client = new EBayClient({
    clientId: 'AppId',
    clientSecret: 'CertId',
    environment,
    fetchImpl,
  });
  const store = new MemoryEBayTokenStore();
  const manager = new EBayTokenManager(client, store, environment);
  const adapter = new EBayAdapter(
    client,
    manager,
    {
      inventoryLocationId: 'inv-location-1',
      categoryId: '183050',
      fulfillmentPolicyId: 'ful-1',
      paymentPolicyId: 'pay-1',
      returnPolicyId: 'ret-1',
    },
  );
  const service = new EBayService({
    client,
    adapter,
    tokenStore: store,
    environment,
    redirectUri: 'https://stoop.phatt.vip/api/ebay/callback',
  });
  return { client, store, manager, adapter, service };
}

test('the consent URL carries PKCE, the state and the scope', () => {
  const { impl } = fakeFetch(() => ({ body: tokenResponse }));
  const { service } = build(impl);

  const url = new URL(service.authorizationUrl('the-state', 'the-challenge'));
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('client_id'), 'AppId');
  assert.equal(url.searchParams.get('state'), 'the-state');
  assert.equal(url.searchParams.get('code_challenge'), 'the-challenge');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://stoop.phatt.vip/api/ebay/callback');
  assert.match(url.searchParams.get('scope') ?? '', /oauth/);
});

test('the sandbox and the production consent URLs are different hosts', () => {
  const { impl } = fakeFetch(() => ({ body: tokenResponse }));
  const sandbox = new URL(build(impl, 'sandbox').service.authorizationUrl('s', 'c'));
  const production = new URL(build(impl, 'production').service.authorizationUrl('s', 'c'));

  assert.match(sandbox.host, /sandbox/);
  assert.match(production.host, /^api\.ebay\.com$/);
  assert.notEqual(sandbox.host, production.host);
});

test('completing the authorization keeps the tokens against the seller', async () => {
  const { impl, calls } = fakeFetch((call) => {
    if (call.url.includes('/oauth2/token')) return { body: tokenResponse };
    if (call.url.includes('/userinfo')) return { body: { user_id: 'seller-42' } };
    return { body: {} };
  });
  const { service, store } = build(impl);

  const result = await service.completeAuthorization('seller-1', 'the-code', 'the-verifier');

  assert.deepEqual(result, { sellerUserId: 'seller-42' });

  const stored = await store.get('seller-1', 'sandbox');
  assert.ok(stored);
  assert.equal(stored.accessToken, 'seller-token');
  assert.equal(stored.refreshToken, 'seller-refresh');
  assert.equal(stored.sellerUserId, 'seller-42');

  const tokenCall = calls.find((c) => c.url.includes('/oauth2/token'));
  assert.match(tokenCall?.body ?? '', /grant_type=authorization_code/);
  assert.match(tokenCall?.body ?? '', /code_verifier=the-verifier/);
});

test('the tokens survive a failed seller lookup, so Emily is not asked to consent twice', async () => {
  const { impl } = fakeFetch((call) => {
    if (call.url.includes('/oauth2/token')) return { body: tokenResponse };
    if (call.url.includes('/userinfo')) return { status: 500, body: { errors: [] } };
    return { body: {} };
  });
  const { service, store } = build(impl);

  const result = await service.completeAuthorization('seller-1', 'the-code', 'the-verifier');

  assert.deepEqual(result, {});
  const stored = await store.get('seller-1', 'sandbox');
  assert.ok(stored, 'the tokens are still kept');
  assert.equal(stored.accessToken, 'seller-token');
});

test('a sandbox token is never served for a production request', async () => {
  const { impl } = fakeFetch(() => ({ body: tokenResponse }));
  const sandbox = build(impl, 'sandbox');
  const production = build(impl, 'production');

  await sandbox.service.completeAuthorization('seller-1', 'the-code', 'the-verifier');

  assert.ok(await sandbox.store.get('seller-1', 'sandbox'));
  assert.equal(
    await sandbox.store.get('seller-1', 'production'),
    undefined,
    'the sandbox tokens do not leak into production',
  );
});

test('publishing before the account is connected is refused, not attempted', async () => {
  const { impl, calls } = fakeFetch(() => ({ body: tokenResponse }));
  const { adapter } = build(impl);

  await assert.rejects(
    () =>
      adapter.publish({
        itemId: 'item-1',
        title: 'Print no. 3',
        description: 'Framed.',
        priceCents: 3500,
        tags: [],
        originalOrVintage: true,
        attribution: { whoMade: 'i_did', whenMade: '2020_2023' },
        taxonomyId: 0,
        images: [],
      }),
    (error: Error) => {
      assert.ok(error instanceof EBayPolicyError);
      assert.equal((error as EBayPolicyError).code, 'ebay_not_connected');
      return true;
    },
  );

  assert.equal(calls.filter((c) => c.url.includes('/sell/')).length, 0, 'nothing is sent to eBay');
});

test('an expiring access token is refreshed before it is used', async () => {
  const { impl, calls } = fakeFetch((call) => {
    if (call.url.includes('/oauth2/token')) {
      return { body: { ...tokenResponse, access_token: 'fresh-token', expires_in: 7200 } };
    }
    return { body: {} };
  });
  const { manager, store } = build(impl);

  // A token that expired a minute ago.
  await store.save('seller-1', 'sandbox', {
    accessToken: 'stale-token',
    tokenType: 'Bearer',
    refreshToken: 'seller-refresh',
    expiresIn: -60,
  });

  const token = await manager.accessToken();
  assert.equal(token, 'fresh-token');

  const tokenCall = calls.find((c) => c.url.includes('/oauth2/token'));
  assert.match(tokenCall?.body ?? '', /grant_type=refresh_token/);
  assert.match(tokenCall?.body ?? '', /refresh_token=seller-refresh/);
});

test('a refresh token that has expired is reported as re-consent, not as a crash', async () => {
  const { impl } = fakeFetch(() => ({ body: tokenResponse }));
  const { manager, store } = build(impl);

  const internal = store as unknown as {
    tokens: Map<string, { refreshExpiresAt: string; accessExpiresAt: string }>;
  };
  await store.save('seller-1', 'sandbox', {
    accessToken: 'stale-token',
    tokenType: 'Bearer',
    refreshToken: 'seller-refresh',
    expiresIn: -60,
  });
  const key = [...internal.tokens.keys()][0];
  internal.tokens.get(key)!.refreshExpiresAt = new Date(Date.now() - 1000).toISOString();

  await assert.rejects(
    () => manager.accessToken(),
    (error: Error) => {
      assert.ok(error instanceof EBayPolicyError);
      assert.equal((error as EBayPolicyError).code, 'ebay_reconsent_required');
      return true;
    },
  );
});
