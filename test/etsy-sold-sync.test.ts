import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Ledger } from '../src/ledger.ts';
import { createApp, listen } from '../src/server.ts';
import { computeSignature } from '../src/etsy-webhook.ts';
import { EtsyAdapter, EtsyClient } from '../src/etsy.ts';
import { EtsyService } from '../src/etsy-service.ts';
import { EtsyTokenManager, MemoryEtsyTokenStore, MemoryRemoteActionStore } from '../src/etsy-store.ts';
import { DelistRunner } from '../src/sync.ts';
import type { MarketplaceAdapter } from '../src/adapter.ts';

const SECRET = 'whsec_c2VjcmV0LWtleS1mb3ItdGhlLXRlc3RzLTExMjM0NTY3OA==';
const NOW = 1_700_000_000;

const RECEIPT = {
  receipt_id: 7,
  is_paid: true,
  grand_total: { amount: 3500, divisor: 100, currency_code: 'USD' },
  transactions: [{ listing_id: 555, paid_timestamp: NOW }],
};

interface Harness {
  ledger: Ledger;
  item: { id: string };
  queue: MemoryRemoteActionStore;
  ended: string[];
  server: import('node:http').Server;
}

async function build(options: { secret?: string; receipt?: unknown } = {}): Promise<Harness> {
  const ledger = new Ledger();
  const seller = ledger.addSeller({ id: 'seller_1', authUserId: 'auth-emily', displayName: 'Emily' });
  const item = ledger.createItem({
    sellerId: seller.id,
    title: 'Print no. 3',
    description: 'A print.',
    priceCents: 3500,
    originalOrVintage: true,
  });
  ledger.publish(item.id, 'etsy', '555');
  ledger.publish(item.id, 'ebay', 'offer-1');

  const fetchImpl = (async (url: string) => {
    if (String(url).includes('/receipts/')) {
      return new Response(JSON.stringify(options.receipt ?? RECEIPT), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;

  const client = new EtsyClient({ apiKey: 'etsy-key', fetchImpl });
  const tokenStore = new MemoryEtsyTokenStore();
  const tokenManager = new EtsyTokenManager(client, tokenStore);
  await tokenStore.save(seller.id, {
    accessToken: '12345678.token',
    refreshToken: '12345678.refresh',
    expiresIn: 3600,
    shopId: '42',
  });

  const ended: string[] = [];
  const ebayAdapter: MarketplaceAdapter = {
    marketplace: 'ebay',
    publish: async () => ({ remoteId: 'offer-1' }),
    end: async (remoteId: string) => {
      ended.push(remoteId);
      return { ended: true };
    },
  };
  const queue = new MemoryRemoteActionStore();
  const delist = new DelistRunner(queue, { ebay: ebayAdapter });

  const etsyAdapter = new EtsyAdapter(
    client,
    { accessToken: async () => '12345678.token' },
    { shopId: '42', defaultTaxonomyId: 1 },
  );

  const service = new EtsyService(
    {
      client,
      adapter: etsyAdapter,
      tokenStore,
      tokenManager,
      webhookSecrets: [options.secret ?? SECRET],
      shopId: '42',
      taxonomyId: 1,
      scope: 'listings_w transactions_r',
      redirectUri: 'https://stoop.phatt.vip/api/etsy/callback',
      now: () => NOW * 1000,
    },
    ledger,
    delist,
  );

  const { server } = createApp({
    ledger,
    verifySession: () => ({ authUserId: 'auth-emily', displayName: 'Emily' }),
    etsy: service,
    remoteActions: queue,
    delist,
    sessionSecret: 'test-secret',
  });

  return { ledger, item, queue, ended, server };
}

async function withServer(
  options: { secret?: string; receipt?: unknown } | undefined,
  run: (ctx: { base: string } & Harness) => Promise<void>,
): Promise<void> {
  const harness = await build(options);
  const { port, close } = await listen(harness.server);
  try {
    await run({ base: `http://127.0.0.1:${port}`, ...harness });
  } finally {
    await close();
  }
}

function signedDelivery(options: { id?: string; timestamp?: number; secret?: string; body?: unknown } = {}) {
  const body = options.body ?? {
    event_type: 'order.paid',
    shop_id: 42,
    resource_url: 'https://openapi.etsy.com/v3/application/shops/42/receipts/7',
  };
  const raw = Buffer.from(JSON.stringify(body), 'utf8');
  const id = options.id ?? 'wh_1';
  const timestamp = options.timestamp ?? NOW;
  const secret = options.secret ?? SECRET;
  return {
    raw,
    headers: {
      'content-type': 'application/json',
      'webhook-id': id,
      'webhook-timestamp': String(timestamp),
      'webhook-signature': computeSignature(secret, id, timestamp, raw),
    },
  };
}

async function post(base: string, delivery: { raw: Buffer; headers: Record<string, string> }) {
  return fetch(`${base}/webhooks/etsy`, {
    method: 'POST',
    headers: delivery.headers,
    body: new Uint8Array(delivery.raw),
  });
}

test('a forged webhook does not sell anything', async () => {
  await withServer(undefined, async ({ base, ledger, item, ended }) => {
    const delivery = signedDelivery();
    const res = await post(base, {
      raw: delivery.raw,
      headers: { ...delivery.headers, 'webhook-signature': 'forged' },
    });
    assert.equal(res.status, 401);
    assert.equal(ledger.isSold(item.id), false);
    assert.deepEqual(ended, []);
  });
});

test('a replayed delivery outside the window does not sell anything', async () => {
  await withServer(undefined, async ({ base, ledger, item }) => {
    const delivery = signedDelivery({ timestamp: NOW - 3600 });
    const res = await post(base, delivery);
    assert.equal(res.status, 401);
    assert.equal(ledger.isSold(item.id), false);
  });
});

test('a verified paid order ends the item and the other channel', async () => {
  await withServer(undefined, async ({ base, ledger, item, ended, queue }) => {
    const res = await post(base, signedDelivery());
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string; endedListings: number };
    assert.equal(body.status, 'sale_recorded');
    assert.equal(body.endedListings, 1);

    // The sale is the truth: the item is sold and the eBay listing is ended.
    assert.equal(ledger.isSold(item.id), true);
    const sale = ledger.getSale(item.id);
    assert.equal(sale?.marketplace, 'etsy');
    assert.equal(sale?.amountCents, 3500);
    assert.ok(sale?.receipt, 'the receipt was kept');

    // The remote delist actually happened, and it is recorded as done.
    assert.deepEqual(ended, ['offer-1']);
    const actions = await queue.listOpen();
    assert.equal(actions.length, 0, 'nothing is left for a human');
  });
});

test('the same webhook twice changes nothing the second time', async () => {
  await withServer(undefined, async ({ base, ledger, item, ended }) => {
    const first = await post(base, signedDelivery());
    assert.equal(first.status, 200);

    const second = await post(base, signedDelivery());
    assert.equal(second.status, 200);
    const body = (await second.json()) as { status: string };
    assert.equal(body.status, 'ignored_duplicate_webhook');

    assert.equal(ledger.isSold(item.id), true);
    assert.equal(ledger.getDuplicateSales(item.id).length, 0);
    assert.deepEqual(ended, ['offer-1'], 'the other channel was not ended twice');
  });
});

test('a sale for a listing stoop does not know is queued for a human', async () => {
  await withServer(
    {
      receipt: {
        receipt_id: 8,
        is_paid: true,
        grand_total: { amount: 1200, divisor: 100, currency_code: 'USD' },
        transactions: [{ listing_id: 999, paid_timestamp: NOW }],
      },
    },
    async ({ base, ledger, item, queue }) => {
      const res = await post(base, signedDelivery());
      assert.equal(res.status, 200);
      const body = (await res.json()) as { status: string };
      assert.equal(body.status, 'unknown_listing');
      assert.equal(ledger.isSold(item.id), false, 'a sale we cannot place is not a sale we record');

      const actions = await queue.listOpen();
      assert.equal(actions.length, 1);
      assert.equal(actions[0].needsHuman, true);
      assert.equal(actions[0].action, 'review');
    },
  );
});

test('an event that is not a paid order is ignored', async () => {
  await withServer(undefined, async ({ base, ledger, item }) => {
    const delivery = signedDelivery({
      body: { event_type: 'listing.updated', shop_id: 42, listing_id: 555 },
    });
    const res = await post(base, delivery);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string };
    assert.equal(body.status, 'ignored');
    assert.equal(ledger.isSold(item.id), false);
  });
});
