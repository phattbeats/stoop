import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EBayClient, EBayError, EBayPolicyError, readEbayErrorMessage } from '../src/ebay-client.ts';

interface FakeCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeFetch(handler: (call: FakeCall) => { status?: number; body?: unknown; headers?: Record<string, string> }) {
  const calls: FakeCall[] = [];
  const impl = (async (url: string, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    const call: FakeCall = { url: String(url), method: init.method ?? 'GET', headers, body: init.body };
    calls.push(call);
    const result = handler(call);
    const status = result.status ?? 200;
    const body = status === 204 || status === 205 ? null : result.body === undefined ? '' : JSON.stringify(result.body);
    return new Response(body, {
      status,
      headers: { 'content-type': 'application/json', ...(result.headers ?? {}) },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const tokenResponse = { access_token: 'token-1', token_type: 'Bearer', expires_in: 7200 };

function clientWith(fetchImpl: typeof fetch, options: { refreshToken?: string; now?: () => number } = {}) {
  return new EBayClient({
    clientId: 'AppId',
    clientSecret: 'CertId',
    environment: 'sandbox',
    fetchImpl,
    ...(options.refreshToken ? { refreshToken: options.refreshToken } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
}

test('the app token is fetched with client credentials and cached', async () => {
  const { impl, calls } = fakeFetch((call) => {
    if (call.url.includes('/identity/v1/oauth2/token')) return { body: tokenResponse };
    return { body: { ok: true } };
  });
  const client = clientWith(impl);

  await client.request('/sell/inventory/v1/listing_summary');
  await client.request('/sell/inventory/v1/listing_summary');

  const tokenCalls = calls.filter((call) => call.url.includes('/oauth2/token'));
  assert.equal(tokenCalls.length, 1, 'the token is fetched once and reused');

  const tokenCall = tokenCalls[0];
  assert.equal(tokenCall.method, 'POST');
  assert.equal(tokenCall.headers['content-type'], 'application/x-www-form-urlencoded');
  // The secret goes in the Authorization header, never in the form body.
  assert.equal(tokenCall.headers.authorization, `Basic ${Buffer.from('AppId:CertId').toString('base64')}`);
  assert.ok(String(tokenCall.body).startsWith('grant_type=client_credentials'));
  assert.ok(String(tokenCall.body).includes('scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope'));
  assert.ok(!String(tokenCall.body).includes('CertId'), 'the client secret must not be in the request body');
});

test('every API call carries the bearer and the marketplace header', async () => {
  const { impl, calls } = fakeFetch((call) => {
    if (call.url.includes('/oauth2/token')) return { body: tokenResponse };
    return { body: { ok: true } };
  });
  const client = clientWith(impl);

  await client.request('/sell/inventory/v1/listing_summary');

  const apiCall = calls.find((call) => call.url.includes('/sell/inventory/'));
  assert.ok(apiCall);
  assert.equal(apiCall?.headers.authorization, 'Bearer token-1');
  assert.equal(apiCall?.headers['x-ebay-c-marketplace-id'], '0');
});

test('a 401 refreshes the token once and replays the request', async () => {
  let seen = 0;
  let refreshes = 0;
  const { impl, calls } = fakeFetch((call) => {
    if (call.url.includes('/oauth2/token')) {
      // The first token is the seller token; each refresh returns a new one.
      const grants = String(call.body);
      if (grants.includes('grant_type=refresh_token')) {
        refreshes += 1;
        return { body: { access_token: `token-${refreshes}`, token_type: 'Bearer', expires_in: 7200 } };
      }
      return { body: tokenResponse };
    }
    seen += 1;
    if (seen === 1) return { status: 401, body: { errors: [{ errorId: 21920500, message: 'Invalid access token' }] } };
    return { body: { listingId: 'L1' } };
  });
  const client = clientWith(impl, { refreshToken: 'refresh-1' });

  const payload = await client.request('/sell/inventory/v1/listing_summary');

  assert.deepEqual(payload, { listingId: 'L1' });
  const tokenCalls = calls.filter((call) => call.url.includes('/oauth2/token'));
  assert.equal(tokenCalls.length, 2, 'one seller token, one refresh');
  assert.ok(String(tokenCalls[1]?.body).includes('grant_type=refresh_token'));
  assert.ok(String(tokenCalls[1]?.body).includes('refresh_token=refresh-1'));

  const apiCalls = calls.filter((call) => call.url.includes('/sell/inventory/'));
  assert.equal(apiCalls.length, 2, 'the request is replayed exactly once');
  assert.equal(apiCalls[0]?.headers.authorization, 'Bearer token-1');
  assert.equal(apiCalls[1]?.headers.authorization, 'Bearer token-2');
});

test('two 401s is a failure, not a loop', async () => {
  const { impl, calls } = fakeFetch((call) => {
    if (call.url.includes('/oauth2/token')) return { body: tokenResponse };
    return { status: 401, body: { errors: [{ message: 'Invalid access token' }] } };
  });
  const client = clientWith(impl, { refreshToken: 'refresh-1' });

  await assert.rejects(
    () => client.request('/sell/inventory/v1/listing_summary'),
    (error: unknown) => error instanceof EBayError && error.status === 401,
  );

  const apiCalls = calls.filter((call) => call.url.includes('/sell/inventory/'));
  assert.equal(apiCalls.length, 2, 'one original attempt and one replay, then it stops');
});

test('a 400 is reported with eBay own message and is not retried', async () => {
  const { impl, calls } = fakeFetch((call) => {
    if (call.url.includes('/oauth2/token')) return { body: tokenResponse };
    return { status: 400, body: { errors: [{ errorId: 2001, message: 'Field categoryId is required' }] } };
  });
  const client = clientWith(impl);

  await assert.rejects(
    () => client.request('/sell/inventory/v1/offer', { method: 'POST', body: '{}' }),
    (error: unknown) =>
      error instanceof EBayError &&
      error.status === 400 &&
      error.message === 'Field categoryId is required' &&
      error.retryable === false,
  );

  const apiCalls = calls.filter((call) => call.url.includes('/sell/inventory/'));
  assert.equal(apiCalls.length, 1, 'a bad request is not repeated');
});

test('a 429 waits for retry-after and is tried again', async () => {
  const slept: number[] = [];
  let apiCalls = 0;
  const { impl } = fakeFetch((call) => {
    if (call.url.includes('/oauth2/token')) return { body: tokenResponse };
    apiCalls += 1;
    if (apiCalls === 1) return { status: 429, body: { errors: [{ message: 'Too many requests' }] }, headers: { 'retry-after': '2' } };
    return { body: { ok: true } };
  });
  const client = new EBayClient({
    clientId: 'AppId',
    clientSecret: 'CertId',
    fetchImpl: impl,
    sleep: async (ms) => {
      slept.push(ms);
    },
  });

  const payload = await client.request('/sell/inventory/v1/listing_summary');

  assert.deepEqual(payload, { ok: true });
  assert.deepEqual(slept, [2000], 'the wait comes from retry-after, not a guess');
});

test('a token response without an access token is a failure', async () => {
  const { impl } = fakeFetch(() => ({ body: { token_type: 'Bearer' } }));
  const client = clientWith(impl);

  await assert.rejects(
    () => client.request('/sell/inventory/v1/listing_summary'),
    (error: unknown) => error instanceof EBayError && error.message === 'ebay returned no access token',
  );
});

test('the consent URL carries PKCE and names the sandbox host', () => {
  const client = new EBayClient({ clientId: 'AppId', clientSecret: 'CertId', environment: 'sandbox' });
  const url = new URL(
    client.authorizationUrl({
      redirectUri: 'https://stoop.phatt.vip/api/ebay/callback',
      state: 'state-1',
      codeChallenge: 'challenge-1',
    }),
  );

  assert.equal(url.hostname, 'api.sandbox.ebay.com');
  assert.equal(url.pathname, '/identity/v1/oauth2/authorize');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('client_id'), 'AppId');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://stoop.phatt.vip/api/ebay/callback');
  assert.equal(url.searchParams.get('state'), 'state-1');
  assert.equal(url.searchParams.get('code_challenge'), 'challenge-1');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('scope'), 'https://api.ebay.com/oauth/api_scope');
});

test('production and sandbox are different hosts, and the default is the sandbox', () => {
  const sandbox = new EBayClient({ clientId: 'AppId', clientSecret: 'CertId' });
  const production = new EBayClient({ clientId: 'AppId', clientSecret: 'CertId', environment: 'production' });

  assert.equal(new URL(sandbox.authorizationUrl({ redirectUri: 'https://x/cb', state: 's', codeChallenge: 'c' })).hostname, 'api.sandbox.ebay.com');
  assert.equal(new URL(production.authorizationUrl({ redirectUri: 'https://x/cb', state: 's', codeChallenge: 'c' })).hostname, 'api.ebay.com');
});

test('an expired cached token is refetched rather than reused', async () => {
  let tokenCalls = 0;
  const { impl, calls } = fakeFetch((call) => {
    if (call.url.includes('/oauth2/token')) {
      tokenCalls += 1;
      return { body: { access_token: `token-${tokenCalls}`, token_type: 'Bearer', expires_in: 120 } };
    }
    return { body: { ok: true } };
  });
  let clock = 1_000_000;
  const client = clientWith(impl, { now: () => clock });

  await client.request('/sell/inventory/v1/listing_summary');
  // Past the token's lifetime minus the skew: the cache is stale.
  clock += 120_000;
  await client.request('/sell/inventory/v1/listing_summary');

  assert.equal(calls.filter((call) => call.url.includes('/oauth2/token')).length, 2);
});

test('ebay error payloads are read for their message', () => {
  assert.equal(
    readEbayErrorMessage({ errors: [{ errorId: 1, message: 'Field title is required' }] }),
    'Field title is required',
  );
  assert.equal(readEbayErrorMessage({}), undefined);
  assert.equal(readEbayErrorMessage('nope'), undefined);
  assert.ok(new EBayPolicyError('ebay_scope', 'nope') instanceof Error);
});
