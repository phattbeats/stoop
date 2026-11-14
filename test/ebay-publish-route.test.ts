/**
 * The eBay publish route, end to end over HTTP.
 *
 * The adapter is already proven against a fake eBay. What is proven here is
 * that the HTTP surface actually routes to it, and that the failure modes
 * come back as the right codes instead of a 500 with a stack in it.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp, listen, type Session } from '../src/server.ts';
import { EBayError, EBayPolicyError } from '../src/ebay-client.ts';
import type { EndResult, PublishRequest, PublishResult } from '../src/adapter.ts';

interface FakeAdapter {
  marketplace: 'ebay';
  publish(request: PublishRequest): Promise<PublishResult>;
  end(remoteId: string): Promise<EndResult>;
}

async function withServer(
  adapter: FakeAdapter | undefined,
  run: (ctx: { base: string; close: () => Promise<void>; cookie: string }) => Promise<void>,
): Promise<void> {
  const sessions: Record<string, Session> = {
    'emily-token': { authUserId: 'auth-emily', displayName: 'Emily' },
  };
  const { server } = createApp({
    verifySession: (token) => (token ? sessions[token] ?? null : null),
    ...(adapter ? { ebay: adapter } : {}),
  });
  const { port, close } = await listen(server);
  await run({ base: `http://127.0.0.1:${port}`, close, cookie: 'stoop_session=emily-token' });
}

async function makeItem(base: string, cookie: string): Promise<string> {
  const created = await fetch(`${base}/api/items`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ title: 'Print no. 3', description: 'Framed screen print.', priceCents: 3500 }),
  });
  const { item } = (await created.json()) as { item: { id: string } };
  return item.id;
}

test('publishing to eBay goes through the adapter and stores the offer id', async () => {
  const seen: PublishRequest[] = [];
  const adapter: FakeAdapter = {
    marketplace: 'ebay',
    async publish(request) {
      seen.push(request);
      return { remoteId: 'offer-99', state: 'PUBLISHED' };
    },
    async end() {
      return { ended: true };
    },
  };

  await withServer(adapter, async ({ base, close, cookie }) => {
    const itemId = await makeItem(base, cookie);
    const res = await fetch(`${base}/api/items/${itemId}/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ marketplace: 'ebay' }),
    });

    assert.equal(res.status, 200);
    const body = (await res.json()) as { listing: { marketplace: string; remoteId: string } };
    assert.equal(body.listing.marketplace, 'ebay');
    assert.equal(body.listing.remoteId, 'offer-99');

    assert.equal(seen.length, 1);
    assert.equal(seen[0].itemId, itemId);
    assert.equal(seen[0].priceCents, 3500);

    await close();
  });
});

test('publishing to eBay without a configured adapter is refused, not attempted', async () => {
  await withServer(undefined, async ({ base, close, cookie }) => {
    const itemId = await makeItem(base, cookie);
    const res = await fetch(`${base}/api/items/${itemId}/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ marketplace: 'ebay' }),
    });

    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: 'ebay_not_configured' });
    await close();
  });
});

test('an eBay policy failure comes back as a 400 with the reason', async () => {
  const adapter: FakeAdapter = {
    marketplace: 'ebay',
    async publish() {
      throw new EBayPolicyError(
        'ebay_offer_not_live',
        'ebay created the offer but it is DRAFT, not live',
      );
    },
    async end() {
      return { ended: true };
    },
  };

  await withServer(adapter, async ({ base, close, cookie }) => {
    const itemId = await makeItem(base, cookie);
    const res = await fetch(`${base}/api/items/${itemId}/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ marketplace: 'ebay' }),
    });

    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string; detail: string };
    assert.equal(body.error, 'ebay_offer_not_live');
    assert.match(body.detail, /DRAFT/);
    await close();
  });
});

test('an eBay transport failure comes back as a 502', async () => {
  const adapter: FakeAdapter = {
    marketplace: 'ebay',
    async publish() {
      throw new EBayError('ebay request failed', 500);
    },
    async end() {
      return { ended: true };
    },
  };

  await withServer(adapter, async ({ base, close, cookie }) => {
    const itemId = await makeItem(base, cookie);
    const res = await fetch(`${base}/api/items/${itemId}/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ marketplace: 'ebay' }),
    });

    assert.equal(res.status, 502);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, 'ebay_publish_failed');
    await close();
  });
});

test('a manual remote id still publishes without touching the adapter', async () => {
  let called = 0;
  const adapter: FakeAdapter = {
    marketplace: 'ebay',
    async publish() {
      called += 1;
      return { remoteId: 'offer-1' };
    },
    async end() {
      return { ended: true };
    },
  };

  await withServer(adapter, async ({ base, close, cookie }) => {
    const itemId = await makeItem(base, cookie);
    const res = await fetch(`${base}/api/items/${itemId}/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ marketplace: 'ebay', remoteId: 'offer-existing' }),
    });

    assert.equal(res.status, 200);
    assert.equal(called, 0, 'a listing somebody else created is not republished');
    await close();
  });
});
