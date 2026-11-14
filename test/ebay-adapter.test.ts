/**
 * The eBay adapter against a fake transport.
 *
 * These are the day-one breakers for the eBay slice, and none of them needs
 * a credential — which is the point: the behaviour that decides whether
 * Emily's one-off becomes a purchasable listing can be proven before the
 * keyset exists.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EBayAdapter } from '../src/ebay.ts';
import { EBayClient, EBayError } from '../src/ebay-client.ts';

interface FakeCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeFetch(
  handler: (call: FakeCall) => { status?: number; body?: unknown; headers?: Record<string, string> },
) {
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
    const body =
      status === 204 || status === 205 ? null : result.body === undefined ? '' : JSON.stringify(result.body);
    return new Response(body, {
      status,
      headers: { 'content-type': 'application/json', ...(result.headers ?? {}) },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const tokenResponse = { access_token: 'seller-token', token_type: 'Bearer', expires_in: 7200 };

const adapterOptions = {
  inventoryLocationId: 'inv-location-1',
  categoryId: '183050',
  fulfillmentPolicyId: 'ful-1',
  paymentPolicyId: 'pay-1',
  returnPolicyId: 'ret-1',
  marketplace: 'EBAY_US',
};

function adapterWith(
  fetchImpl: typeof fetch,
  options: Partial<typeof adapterOptions> = {},
) {
  const client = new EBayClient({
    clientId: 'AppId',
    clientSecret: 'CertId',
    environment: 'sandbox',
    fetchImpl,
  });
  const adapter = new EBayAdapter(
    client,
    { accessToken: async () => 'seller-token' },
    { ...adapterOptions, ...options },
  );
  return { adapter, client };
}

function publishRequest(overrides: Record<string, unknown> = {}) {
  return {
    itemId: 'item-abc-123',
    title: 'Print no. 3',
    description: 'Screen print, framed.',
    priceCents: 3500,
    tags: ['print'],
    originalOrVintage: true,
    attribution: { whoMade: 'i_did' as const, whenMade: '2020_2023' },
    taxonomyId: 1,
    images: [],
    ...overrides,
  } as any;
}

/** A transport that walks the happy path: item, offer, policies, read-back. */
function happyPath(overrides: {
  offerState?: string;
  onCall?: (call: FakeCall) => void;
} = {}) {
  return fakeFetch((call) => {
    overrides.onCall?.(call);
    if (call.url.includes('/oauth2/token')) return { body: tokenResponse };
    if (call.url.includes('/inventory_items')) return { body: { inventoryItemId: 'inv-1' } };
    if (call.url.includes('/listingPolicies')) return { body: { success: true } };
    if (call.url.endsWith('/offer/offer-1')) {
      return { body: { offerId: 'offer-1', status: overrides.offerState ?? 'PUBLISHED' } };
    }
    if (call.url.endsWith('/offer')) return { body: { offerId: 'offer-1' } };
    return { body: {} };
  });
}

test('publishing creates the inventory item, the offer and the listing policies, in that order', async () => {
  const { impl, calls } = happyPath();
  const { adapter } = adapterWith(impl);

  const result = await adapter.publish(publishRequest());

  assert.equal(result.remoteId, 'offer-1');
  assert.equal(result.state, 'PUBLISHED');

  const paths = calls.filter((c) => !c.url.includes('/oauth2/token')).map((c) => c.url.replace(/^https?:\/\/[^/]+/, ''));
  assert.deepEqual(paths, [
    '/sell/inventory/v1/inventory_items',
    '/sell/inventory/v1/offer',
    '/sell/inventory/v1/offer/offer-1/listingPolicies',
    '/sell/inventory/v1/offer/offer-1',
  ]);
});

test('the SKU is derived from the Stoop item id, so it is unique and never collides', async () => {
  const { impl, calls } = happyPath();
  const { adapter } = adapterWith(impl);

  await adapter.publish(publishRequest({ itemId: 'item-abc-123' }));

  const itemCall = calls.find((c) => c.url.includes('/inventory_items'));
  const body = JSON.parse(String(itemCall?.body));
  assert.equal(body.product.sellerSKU, 'STOOP-item-abc-123');

  // Two different items with the same title must not share a SKU.
  const second = happyPath();
  const other = adapterWith(second.impl);
  await other.adapter.publish(publishRequest({ itemId: 'item-xyz-999' }));
  const otherCall = second.calls.find((c) => c.url.includes('/inventory_items'));
  const otherBody = JSON.parse(String(otherCall?.body));
  assert.notEqual(otherBody.product.sellerSKU, body.product.sellerSKU);
});

test('the offer carries the price, the quantity, the marketplace and the category', async () => {
  const { impl, calls } = happyPath();
  const { adapter } = adapterWith(impl);

  await adapter.publish(publishRequest({ priceCents: 3500, quantity: 1 }));

  const offerCall = calls.find((c) => c.url.endsWith('/offer') && c.method === 'POST');
  const body = JSON.parse(String(offerCall?.body));
  assert.equal(body.format, 'FIXED_PRICE');
  assert.equal(body.pricingSummary.price.value, 35);
  assert.equal(body.pricingSummary.price.currency, 'USD');
  assert.equal(body.pricingSummary.quantity, 1);
  assert.equal(body.marketplaceId, 'EBAY_US');
  assert.equal(body.category.categoryId, '183050');
  assert.equal(body.inventoryItemId, 'inv-1', 'the offer points at the item it was created for');
});

test('the offer carries a condition and an available quantity, because eBay requires both', async () => {
  const { impl, calls } = happyPath();
  const { adapter } = adapterWith(impl);

  await adapter.publish(publishRequest({ quantity: 1 }));

  const offerCall = calls.find((c) => c.url.endsWith('/offer') && c.method === 'POST');
  const body = JSON.parse(String(offerCall?.body));
  assert.equal(body.condition, 'NEW', 'an offer without a condition is rejected by eBay');
  assert.equal(body.availableQuantity, 1);
});

test('the inventory item carries the locale eBay needs on the product', async () => {
  const { impl, calls } = happyPath();
  const { adapter } = adapterWith(impl);

  await adapter.publish(publishRequest());

  const itemCall = calls.find((c) => c.url.includes('/inventory_items'));
  const body = JSON.parse(String(itemCall?.body));
  assert.equal(body.product.locale, 'en-US');
});

test('the marketplace can be set explicitly and is not guessed', async () => {
  const { impl, calls } = happyPath();
  const { adapter } = adapterWith(impl, { marketplace: 'EBAY_GB' });

  await adapter.publish(publishRequest());

  const offerCall = calls.find((c) => c.url.endsWith('/offer') && c.method === 'POST');
  const body = JSON.parse(String(offerCall?.body));
  assert.equal(body.marketplaceId, 'EBAY_GB');
});

test('the listing policies carry the three store policies and turn the offer on', async () => {
  const { impl, calls } = happyPath();
  const { adapter } = adapterWith(impl);

  await adapter.publish(publishRequest());

  const policyCall = calls.find((c) => c.url.includes('/listingPolicies'));
  const body = JSON.parse(String(policyCall?.body));
  assert.equal(body.fulfillmentPolicyId, 'ful-1');
  assert.equal(body.paymentPolicyId, 'pay-1');
  assert.equal(body.returnPolicyId, 'ret-1');
  assert.equal(body.listingPolicies.SELLING_POLICY_ACTIVE, true);
});

test('an offer that did not go live is a failure, not a silent success', async () => {
  // This is the one that matters: an offer in DRAFT looks published from the
  // outside, and Emily's print sits there unsellable.
  const { impl } = happyPath({ offerState: 'DRAFT' });
  const { adapter } = adapterWith(impl);

  await assert.rejects(
    () => adapter.publish(publishRequest()),
    (error: Error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /DRAFT/);
      return true;
    },
  );
});

test('an offer that eBay does not create fails loudly instead of storing a bogus id', async () => {
  const { impl } = fakeFetch((call) => {
    if (call.url.includes('/oauth2/token')) return { body: tokenResponse };
    if (call.url.includes('/inventory_items')) return { body: { inventoryItemId: 'inv-1' } };
    return { body: {} };
  });
  const { adapter } = adapterWith(impl);

  await assert.rejects(
    () => adapter.publish(publishRequest()),
    /ebay did not return an offer id/,
  );
});

test('a missing inventory location, category or policy is refused before anything is created', async () => {
  for (const [missing, pattern] of [
    ['inventoryLocationId', /inventory location/],
    ['categoryId', /category id/],
    ['fulfillmentPolicyId', /policies/],
  ] as const) {
    const { impl, calls } = happyPath();
    const { adapter } = adapterWith(impl, { [missing]: '' });

    await assert.rejects(() => adapter.publish(publishRequest()), pattern);

    const wrote = calls.filter((c) => !c.url.includes('/oauth2/token'));
    assert.equal(wrote.length, 0, 'nothing is sent to eBay when the offer cannot be made right');
  }
});

test('a listing needs a title and a price above zero', async () => {
  const { impl } = happyPath();
  const { adapter } = adapterWith(impl);

  await assert.rejects(() => adapter.publish(publishRequest({ title: '   ' })), /title/);
  await assert.rejects(() => adapter.publish(publishRequest({ priceCents: 0 })), /price/);
});

test('ending an offer that is already gone is not a failure', async () => {
  const { impl } = fakeFetch((call) => {
    if (call.url.includes('/oauth2/token')) return { body: tokenResponse };
    return { status: 404, body: { errors: [{ message: 'not found' }] } };
  });
  const { adapter } = adapterWith(impl);

  const result = await adapter.end('offer-1');
  assert.equal(result.ended, true);
  assert.equal(result.alreadyGone, true);
});

test('ending an offer that fails for another reason surfaces the failure', async () => {
  const { impl } = fakeFetch((call) => {
    if (call.url.includes('/oauth2/token')) return { body: tokenResponse };
    return { status: 500, body: { errors: [{ message: 'server blew up' }] } };
  });
  const { adapter } = adapterWith(impl);

  await assert.rejects(() => adapter.end('offer-1'), (error: Error) => {
    assert.ok(error instanceof EBayError);
    return true;
  });
});

test('ending an offer with no id is refused', async () => {
  const { impl } = happyPath();
  const { adapter } = adapterWith(impl);
  await assert.rejects(() => adapter.end('  '), /no eBay offer to end/);
});
