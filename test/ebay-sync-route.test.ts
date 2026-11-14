/**
 * The eBay sale sync over HTTP.
 *
 * The button on the phone is how Emily finds out a print sold, so it has to
 * work when the poll loop is asleep, and it has to fail in a way the phone
 * can show rather than a 500 with a stack in it.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp, listen, type Session } from '../src/server.ts';
import { EBayOrderSync } from '../src/ebay-orders.ts';
import { EBayClient } from '../src/ebay-client.ts';
import { Ledger } from '../src/ledger.ts';
import { DelistRunner } from '../src/sync.ts';
import { MemoryRemoteActionStore } from '../src/etsy-store.ts';
import { EBayAdapter } from '../src/ebay.ts';

async function withServer(
  sync: EBayOrderSync | undefined,
  run: (ctx: { base: string; close: () => Promise<void>; cookie: string }) => Promise<void>,
): Promise<void> {
  const sessions: Record<string, Session> = {
    'emily-token': { authUserId: 'auth-emily', displayName: 'Emily' },
  };
  const { server } = createApp({
    verifySession: (token) => (token ? sessions[token] ?? null : null),
    ...(sync ? { ebaySync: sync } : {}),
  });
  const { port, close } = await listen(server);
  try {
    await run({ base: `http://127.0.0.1:${port}`, close, cookie: 'stoop_session=emily-token' });
  } finally {
    await close();
  }
}

function buildSync(options: { payload?: unknown; failWith?: string } = {}) {
  const ledger = new Ledger();
  const seller = ledger.addSeller({ id: 'seller_1', authUserId: 'auth-emily', displayName: 'Emily' });
  const item = ledger.createItem({ sellerId: seller.id, title: 'Print no. 3', priceCents: 3500 });
  ledger.publish(item.id, 'etsy', 'etsy-listing-1');

  const impl = (async () => {
    if (options.failWith) throw new Error(options.failWith);
    return new Response(JSON.stringify(options.payload ?? { orders: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  const client = new EBayClient({
    clientId: 'AppId',
    clientSecret: 'CertId',
    environment: 'sandbox',
    fetchImpl: impl,
  });

  const ended: string[] = [];
  const delist = new DelistRunner(new MemoryRemoteActionStore(), {
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
  return { sync, ledger, item, seller, ended };
}

test('syncing with no orders reports nothing and does not fail', async () => {
  const { sync } = buildSync({ payload: { orders: [] } });
  await withServer(sync, async ({ base, close, cookie }) => {
    const res = await fetch(`${base}/api/ebay/sync`, { method: 'POST', headers: { cookie } });

    assert.equal(res.status, 200);
    const body = (await res.json()) as { sync: { ordersSeen: number; salesRecorded: number } };
    assert.equal(body.sync.ordersSeen, 0);
    assert.equal(body.sync.salesRecorded, 0);
    await close();
  });
});

test('syncing records the sale and ends the other listing', async () => {
  const sku = EBayAdapter.skuFor('item_0001');
  const { sync, ended } = buildSync({
    payload: {
      orders: [
        {
          orderId: 'order-1',
          lineItems: [
            {
              lineItemId: 'line-1',
              sku,
              quantity: 1,
              lineItemCost: { value: 35, currency: 'USD' },
            },
          ],
        },
      ],
    },
  });

  await withServer(sync, async ({ base, close, cookie }) => {
    const res = await fetch(`${base}/api/ebay/sync`, { method: 'POST', headers: { cookie } });

    assert.equal(res.status, 200);
    const body = (await res.json()) as { sync: { salesRecorded: number; endedListings: number } };
    assert.equal(body.sync.salesRecorded, 1);
    assert.equal(body.sync.endedListings, 1);
    assert.deepEqual(ended, ['etsy-listing-1']);
    await close();
  });
});

test('syncing without a configured eBay is refused', async () => {
  await withServer(undefined, async ({ base, close, cookie }) => {
    const res = await fetch(`${base}/api/ebay/sync`, { method: 'POST', headers: { cookie } });
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: 'ebay_not_configured' });
    await close();
  });
});

test('a sync that cannot reach eBay comes back as a 502, not a crash', async () => {
  const { sync } = buildSync({ failWith: 'ebay could not be reached' });
  await withServer(sync, async ({ base, close, cookie }) => {
    const res = await fetch(`${base}/api/ebay/sync`, { method: 'POST', headers: { cookie } });

    assert.equal(res.status, 502);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, 'ebay_sync_failed');
    await close();
  });
});

test('syncing needs a session', async () => {
  const { sync } = buildSync({ payload: { orders: [] } });
  await withServer(sync, async ({ base, close }) => {
    const res = await fetch(`${base}/api/ebay/sync`, { method: 'POST' });
    assert.equal(res.status, 401);
    await close();
  });
});
