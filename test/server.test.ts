import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp, listen, type Session } from '../src/server.ts';

async function withServer(
  run: (ctx: { base: string; close: () => Promise<void>; cookie: string }) => Promise<void>,
): Promise<void> {
  const sessions: Record<string, Session> = {
    'emily-token': { authUserId: 'auth-emily', displayName: 'Emily' },
    'other-token': { authUserId: 'auth-other', displayName: 'Someone Else' },
  };
  const { server, ledger } = createApp({
    verifySession: (token) => (token ? sessions[token] ?? null : null),
  });
  const { port, close } = await listen(server);
  await run({
    base: `http://127.0.0.1:${port}`,
    close,
    cookie: 'stoop_session=emily-token',
  });
  ledger.listItems();
}

test('every API route refuses to serve without a PHATT ID session', async () => {
  await withServer(async ({ base, close }) => {
    const responses = await Promise.all([
      fetch(`${base}/api/today`),
      fetch(`${base}/api/items`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Print no. 3', priceCents: 3500 }),
      }),
    ]);
    for (const res of responses) {
      assert.equal(res.status, 401);
      assert.deepEqual(await res.json(), { error: 'sign_in_required' });
    }
    await close();
  });
});

test('create an item, then see it on the Today screen', async () => {
  await withServer(async ({ base, close, cookie }) => {
    const created = await fetch(`${base}/api/items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        title: 'Print no. 3',
        priceCents: 3500,
        photos: ['/srv/appdata/stoop/photos/print-3.jpg'],
      }),
    });
    assert.equal(created.status, 201);
    const { item } = (await created.json()) as { item: { id: string; title: string } };
    assert.equal(item.title, 'Print no. 3');

    const today = await fetch(`${base}/api/today`, { headers: { cookie } });
    assert.equal(today.status, 200);
    const body = (await today.json()) as { items: { id: string; photos: string[] }[] };
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].id, item.id);
    assert.equal(body.items[0].photos[0], '/srv/appdata/stoop/photos/print-3.jpg');

    await close();
  });
});

test('a seller cannot see or touch another seller\'s item', async () => {
  await withServer(async ({ base, close, cookie }) => {
    const created = await fetch(`${base}/api/items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ title: 'Print no. 3', priceCents: 3500 }),
    });
    const { item } = (await created.json()) as { item: { id: string } };

    const otherCookie = 'stoop_session=other-token';
    const theirToday = await fetch(`${base}/api/today`, { headers: { cookie: otherCookie } });
    const theirItems = (await theirToday.json()) as { items: unknown[] };
    assert.equal(theirItems.items.length, 0);

    const steal = await fetch(`${base}/api/items/${item.id}/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: otherCookie },
      body: JSON.stringify({ marketplace: 'ebay', remoteId: 'nope' }),
    });
    assert.equal(steal.status, 404);

    await close();
  });
});

test('publish to a marketplace, then mark sold from Facebook: the other listing ends', async () => {
  await withServer(async ({ base, close, cookie }) => {
    const created = await fetch(`${base}/api/items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ title: 'Print no. 3', priceCents: 3500 }),
    });
    const { item } = (await created.json()) as { item: { id: string } };

    for (const [marketplace, remoteId] of [
      ['ebay', 'ebay-offer-1'],
      ['etsy', 'etsy-listing-1'],
    ]) {
      const res = await fetch(`${base}/api/items/${item.id}/publish`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ marketplace, remoteId }),
      });
      assert.equal(res.status, 200);
    }

    const sold = await fetch(`${base}/api/items/${item.id}/mark-sold`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: '{}',
    });
    assert.equal(sold.status, 200);
    const result = (await sold.json()) as { outcome: string; endedListings: number };
    assert.equal(result.outcome, 'sale_recorded');
    assert.equal(result.endedListings, 2);

    const today = await fetch(`${base}/api/today`, { headers: { cookie } });
    const body = (await today.json()) as {
      items: { sold: boolean; listings: { state: string }[] }[];
    };
    assert.equal(body.items[0].sold, true);
    assert.ok(body.items[0].listings.every((l) => l.state === 'ended'));

    await close();
  });
});

test('bad input is rejected with a useful error', async () => {
  await withServer(async ({ base, close, cookie }) => {
    const noTitle = await fetch(`${base}/api/items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ priceCents: 3500 }),
    });
    assert.equal(noTitle.status, 400);
    assert.deepEqual(await noTitle.json(), { error: 'title_required' });

    const badPrice = await fetch(`${base}/api/items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ title: 'Print no. 3', priceCents: 'free' }),
    });
    assert.equal(badPrice.status, 400);

    const badMarketplace = await fetch(`${base}/api/items/nope/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ marketplace: 'poshmark' }),
    });
    assert.equal(badMarketplace.status, 404);

    await close();
  });
});
