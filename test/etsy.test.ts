import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EtsyAdapter, EtsyClient, EtsyPolicyError, summarizeReceipt } from '../src/etsy.ts';

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

const tokens = { accessToken: '12345678.token', refreshToken: '12345678.refresh', expiresIn: 3600 };

function adapterWith(fetchImpl: typeof fetch, options: { shopId?: string } = {}) {
  const client = new EtsyClient({ apiKey: 'etsy-key', fetchImpl });
  const adapter = new EtsyAdapter(
    client,
    { accessToken: async () => tokens.accessToken },
    {
      shopId: options.shopId ?? '42',
      defaultTaxonomyId: 1,
      defaultShippingProfileId: 9,
    },
  );
  return { client, adapter };
}

test('etsy is original/vintage only, and it is enforced at write time', async () => {
  const { impl } = fakeFetch(() => ({ body: {} }));
  const { adapter } = adapterWith(impl);

  await assert.rejects(
    () =>
      adapter.publish({
        itemId: 'item_1',
        title: 'Print no. 3',
        description: 'A print.',
        priceCents: 3500,
        tags: ['print'],
        originalOrVintage: false,
        attribution: { whoMade: 'i_did', whenMade: '2020_2023' },
        taxonomyId: 1,
        images: [],
      }),
    (error: unknown) => error instanceof EtsyPolicyError && error.code === 'etsy_original_vintage_only',
  );

  await assert.rejects(
    () =>
      adapter.publish({
        itemId: 'item_1',
        title: 'Print no. 3',
        description: 'A print.',
        priceCents: 3500,
        tags: ['print'],
        // Nobody has said. That is not a yes.
        originalOrVintage: null,
        attribution: { whoMade: 'i_did', whenMade: '2020_2023' },
        taxonomyId: 1,
        images: [],
      }),
    (error: unknown) => error instanceof EtsyPolicyError && error.code === 'etsy_original_vintage_only',
  );
});

test('publishing creates a draft, uploads the image, then goes active', async () => {
  const { impl, calls } = fakeFetch((call) => {
    if (call.url.endsWith('/listings') && call.method === 'POST') {
      return { status: 201, body: { listing_id: 555, state: 'draft' } };
    }
    if (call.url.includes('/images')) return { status: 201, body: { listing_image_id: 9 } };
    if (call.method === 'PATCH') return { body: { listing_id: 555, state: 'active' } };
    return { body: {} };
  });
  const { adapter } = adapterWith(impl);

  const result = await adapter.publish({
    itemId: 'item_1',
    title: 'Print no. 3',
    description: 'A print.',
    priceCents: 3500,
    tags: ['print', 'lithograph'],
    originalOrVintage: true,
    attribution: { whoMade: 'i_did', whenMade: '2020_2023' },
    taxonomyId: 1,
    images: [{ data: Buffer.from('not really a jpeg'), contentType: 'image/jpeg' }],
  });

  assert.equal(result.remoteId, '555');
  assert.equal(result.state, 'active');

  const create = calls.find((call) => call.method === 'POST' && call.url.endsWith('/listings'));
  assert.ok(create, 'the listing was created');
  const body = new URLSearchParams(String(create.body));
  assert.equal(body.get('title'), 'Print no. 3');
  assert.equal(body.get('price'), '35');
  assert.equal(body.get('quantity'), '1');
  assert.equal(body.get('who_made'), 'i_did');
  assert.equal(body.get('when_made'), '2020_2023');
  assert.equal(body.get('taxonomy_id'), '1');
  assert.equal(body.get('tags'), 'print,lithograph');

  const image = calls.find((call) => call.url.includes('/images'));
  assert.ok(image, 'the image was uploaded');
  const activate = calls.find((call) => call.method === 'PATCH');
  assert.ok(activate, 'the listing was activated');
  assert.equal(new URLSearchParams(String(activate.body)).get('state'), 'active');
});

test('the api key is on every request', async () => {
  const { impl, calls } = fakeFetch(() => ({ body: { listing_id: 1 } }));
  const { adapter } = adapterWith(impl);
  await adapter.publish({
    itemId: 'item_1',
    title: 'Print no. 3',
    description: '',
    priceCents: 100,
    tags: [],
    originalOrVintage: true,
    attribution: { whoMade: 'i_did', whenMade: '2020_2023' },
    taxonomyId: 1,
    images: [],
  });
  assert.ok(calls.every((call) => call.headers['x-api-key'] === 'etsy-key'));
  assert.ok(calls.every((call) => call.headers.authorization === `Bearer ${tokens.accessToken}`));
});

test('a 429 is waited out, not given up on', async () => {
  let attempts = 0;
  const { impl, calls } = fakeFetch((call) => {
    if (call.method === 'POST' && call.url.endsWith('/listings')) {
      attempts += 1;
      if (attempts === 1) return { status: 429, headers: { 'retry-after': '1' }, body: { error: 'slow down' } };
      return { status: 201, body: { listing_id: 777 } };
    }
    return { body: {} };
  });
  const waited: number[] = [];
  const client = new EtsyClient({
    apiKey: 'etsy-key',
    fetchImpl: impl,
    sleep: async (ms) => {
      waited.push(ms);
    },
  });
  const adapter = new EtsyAdapter(
    client,
    { accessToken: async () => tokens.accessToken },
    { shopId: '42', defaultTaxonomyId: 1 },
  );

  const result = await adapter.publish({
    itemId: 'item_1',
    title: 'Print no. 3',
    description: '',
    priceCents: 100,
    tags: [],
    originalOrVintage: true,
    attribution: { whoMade: 'i_did', whenMade: '2020_2023' },
    taxonomyId: 1,
    images: [],
  });

  assert.equal(result.remoteId, '777');
  assert.deepEqual(waited, [1000]);
  assert.ok(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/listings')).length >= 2);
});

test('ending a listing that is already gone is not a failure', async () => {
  const { impl } = fakeFetch(() => ({ status: 404, body: { error: 'not found' } }));
  const { adapter } = adapterWith(impl);
  const result = await adapter.end('555');
  assert.equal(result.ended, true);
  assert.equal(result.alreadyGone, true);
});

test('ending a listing really asks etsy to delete it', async () => {
  const { impl, calls } = fakeFetch(() => ({ status: 204 }));
  const { adapter } = adapterWith(impl);
  const result = await adapter.end('555');
  assert.equal(result.ended, true);
  const call = calls[0];
  assert.equal(call.method, 'DELETE');
  assert.ok(call.url.endsWith('/v3/application/listings/555'));
});

test('a receipt url that is not etsy is never fetched', async () => {
  const { impl, calls } = fakeFetch(() => ({ body: {} }));
  const client = new EtsyClient({ apiKey: 'etsy-key', fetchImpl: impl });
  await assert.rejects(
    () => client.fetchReceipt('https://evil.example.com/receipt/1', tokens.accessToken),
    (error: unknown) => error instanceof EtsyPolicyError && error.code === 'bad_resource_url',
  );
  assert.equal(calls.length, 0);
});

test('the receipt is the authority: listing, amount and time come from it', () => {
  const summary = summarizeReceipt({
    receipt_id: 7,
    is_paid: true,
    grand_total: { amount: 3500, divisor: 100, currency_code: 'USD' },
    transactions: [{ listing_id: 555, paid_timestamp: 1_700_000_000 }],
  });
  assert.equal(summary.listingId, '555');
  assert.equal(summary.amountCents, 3500);
  assert.equal(summary.receiptId, '7');
  assert.equal(summary.isPaid, true);
  assert.equal(summary.occurredAt, new Date(1_700_000_000_000).toISOString());
});

test('a receipt that names no listing is refused', () => {
  assert.throws(
    () => summarizeReceipt({ receipt_id: 7, transactions: [] }),
    (error: unknown) => error instanceof EtsyPolicyError && error.code === 'receipt_without_listing',
  );
});
