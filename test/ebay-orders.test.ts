/**
 * The eBay sale sync.
 *
 * The claim being tested: a sale on eBay ends Stoop's other listings, and a
 * re-poll does not sell the same thing twice.
 *
 * The join is the SKU. An eBay order names the inventory item, not Stoop's
 * item, so the only way back is the seller SKU — which is exactly why the
 * SKU is derived from Stoop's own item id instead of the title.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EBayOrderSync, parseEbayOrders } from '../src/ebay-orders.ts';
import { EBayAdapter } from '../src/ebay.ts';
import { EBayClient } from '../src/ebay-client.ts';
import { Ledger } from '../src/ledger.ts';
import { DelistRunner } from '../src/sync.ts';
import { MemoryRemoteActionStore } from '../src/etsy-store.ts';

interface FakeCall {
  url: string;
  method: string;
}

function fakeFetch(payload: unknown) {
  const calls: FakeCall[] = [];
  const impl = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET' });
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function orderPayload(lines: unknown[], orderId = 'order-1') {
  return {
    orders: [
      {
        orderId,
        creationDate: '2026-11-10T12:00:00Z',
        orderStatus: 'OPEN',
        lineItems: lines,
      },
    ],
  };
}

function build(payload: unknown) {
  const ledger = new Ledger();
  const seller = ledger.addSeller({ id: 'seller_1', authUserId: 'auth-emily', displayName: 'Emily' });
  const item = ledger.createItem({
    sellerId: seller.id,
    title: 'Print no. 3',
    priceCents: 3500,
  });
  // The item is also listed on Etsy, so a sale on eBay has to end it.
  ledger.publish(item.id, 'etsy', 'etsy-listing-1');

  const { impl, calls } = fakeFetch(payload);
  const client = new EBayClient({
    clientId: 'AppId',
    clientSecret: 'CertId',
    environment: 'sandbox',
    fetchImpl: impl,
  });

  const queue = new MemoryRemoteActionStore();
  const ended: string[] = [];
  const delist = new DelistRunner(queue, {
    etsy: {
      marketplace: 'etsy',
      async publish() {
        return { remoteId: 'etsy-listing-1' };
      },
      async end(remoteId: string) {
        ended.push(remoteId);
        return { ended: true };
      },
    },
  });

  const sync = new EBayOrderSync({
    client,
    ledger,
    delist,
    tokens: { accessToken: async () => 'seller-token' },
  });
  return { ledger, item, seller, sync, calls, ended, queue };
}

test('a sale on eBay ends the other channels listings', async () => {
  const sku = EBayAdapter.skuFor('item_0001');
  const { sync, item, ledger, ended } = build(
    orderPayload([
      {
        lineItemId: 'line-1',
        itemId: 'ebay-inv-1',
        sku,
        title: 'Print no. 3',
        quantity: 1,
        lineItemCost: { value: 35, currency: 'USD' },
      },
    ]),
  );

  const result = await sync.sync();

  assert.equal(result.salesRecorded, 1);
  assert.equal(result.endedListings, 1);
  assert.deepEqual(ended, ['etsy-listing-1'], 'the Etsy listing is ended');
  assert.equal(ledger.getSale(item.id)?.marketplace, 'ebay');
  assert.equal(ledger.getSale(item.id)?.amountCents, 3500);
});

test('a re-poll records the sale once and does not end anything twice', async () => {
  const sku = EBayAdapter.skuFor('item_0001');
  const { sync, ended } = build(
    orderPayload([
      {
        lineItemId: 'line-1',
        itemId: 'ebay-inv-1',
        sku,
        quantity: 1,
        lineItemCost: { value: 35, currency: 'USD' },
      },
    ]),
  );

  const first = await sync.sync();
  const second = await sync.sync();

  assert.equal(first.salesRecorded, 1);
  assert.equal(second.salesRecorded, 0);
  assert.equal(second.duplicates, 1);
  assert.equal(ended.length, 1, 'the remote listing is ended once');
});

test('a line for something Stoop does not know is skipped, not failed', async () => {
  const { sync } = build(
    orderPayload([
      {
        lineItemId: 'line-1',
        itemId: 'ebay-inv-9',
        sku: 'STOOP-something-else',
        quantity: 1,
        lineItemCost: { value: 10, currency: 'USD' },
      },
    ]),
  );

  const result = await sync.sync();

  assert.equal(result.salesRecorded, 0);
  assert.equal(result.unmatchedLines, 1);
});

test('an order with one bad line still records the good one', async () => {
  const sku = EBayAdapter.skuFor('item_0001');
  const { sync } = build(
    orderPayload([
      null,
      'not an object',
      {
        lineItemId: 'line-1',
        sku,
        quantity: 1,
        lineItemCost: { value: 35, currency: 'USD' },
      },
    ]),
  );

  const result = await sync.sync();

  assert.equal(result.salesRecorded, 1);
});

test('the price comes off the order line, not off the item', async () => {
  const sku = EBayAdapter.skuFor('item_0001');
  const { sync, item, ledger } = build(
    orderPayload([
      {
        lineItemId: 'line-1',
        sku,
        quantity: 1,
        lineItemCost: { value: 42.5, currency: 'USD' },
      },
    ]),
  );

  await sync.sync();

  // The item was listed at 3500 cents; eBay says it sold for 4250.
  assert.equal(ledger.getSale(item.id)?.amountCents, 4250);
});

test('a line with no price falls back to the listed price', async () => {
  const sku = EBayAdapter.skuFor('item_0001');
  const { sync, item, ledger } = build(orderPayload([{ lineItemId: 'line-1', sku, quantity: 1 }]));

  await sync.sync();

  assert.equal(ledger.getSale(item.id)?.amountCents, 3500);
});

test('the sync asks eBay for the sellers open orders', async () => {
  const { sync, calls } = build(orderPayload([]));
  await sync.sync();

  const call = calls.find((c) => c.url.includes('/sell/fulfillment/v1/order'));
  assert.ok(call, 'the fulfillment API is called');
  assert.match(call!.url, /orderStatuses=OPEN/);
});

test('parsing an order list that is not a list gives no orders', () => {
  assert.deepEqual(parseEbayOrders(undefined), []);
  assert.deepEqual(parseEbayOrders({}), []);
  assert.deepEqual(parseEbayOrders({ orders: 'nope' }), []);
  assert.deepEqual(parseEbayOrders({ orders: [{ noOrderId: true }] }), []);
});

test('parsing keeps the fields a sale needs and skips the rest', () => {
  const orders = parseEbayOrders({
    orders: [
      {
        orderId: 'order-1',
        creationDate: '2026-11-10T12:00:00Z',
        orderStatus: 'OPEN',
        lineItems: [
          {
            lineItemId: 'line-1',
            sku: 'STOOP-item_0001',
            itemId: 'ebay-inv-1',
            title: 'Print no. 3',
            quantity: 1,
            lineItemCost: { value: 35, currency: 'USD' },
          },
        ],
      },
    ],
  });

  assert.equal(orders.length, 1);
  assert.equal(orders[0].orderId, 'order-1');
  assert.equal(orders[0].lines.length, 1);
  assert.equal(orders[0].lines[0].sku, 'STOOP-item_0001');
  assert.equal(orders[0].lines[0].amountCents, 3500);
  assert.equal(orders[0].lines[0].currency, 'USD');
});

test('a line with a plain number price is read too', () => {
  const orders = parseEbayOrders({
    orders: [
      {
        orderId: 'order-1',
        lineItems: [{ lineItemId: 'line-1', sku: 'STOOP-x', quantity: 1, lineItemCost: 35 }],
      },
    ],
  });

  assert.equal(orders[0].lines[0].amountCents, 3500);
});
