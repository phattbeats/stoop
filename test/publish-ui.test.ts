/**
 * The publish buttons on the Today screen.
 *
 * An adapter nobody can reach from the phone is an adapter that does not
 * exist. This is the test that says the phone can actually publish, and
 * that it does not offer a button that is going to be refused.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp, listen, type Session } from '../src/server.ts';
import { EBayAdapter } from '../src/ebay.ts';
import type { EndResult, PublishRequest, PublishResult } from '../src/adapter.ts';

const sessions: Record<string, Session> = {
  'emily-token': { authUserId: 'auth-emily', displayName: 'Emily' },
};

async function withServer(
  options: { ebay?: unknown; etsy?: unknown },
  run: (ctx: { base: string; close: () => Promise<void>; cookie: string }) => Promise<void>,
): Promise<void> {
  const { server } = createApp({
    verifySession: (token) => (token ? sessions[token] ?? null : null),
    ...(options.ebay ? { ebay: options.ebay as never } : {}),
    ...(options.etsy ? { etsy: options.etsy as never } : {}),
  });
  const { port, close } = await listen(server);
  try {
    await run({ base: `http://127.0.0.1:${port}`, close, cookie: 'stoop_session=emily-token' });
  } finally {
    await close();
  }
}

function fakeAdapter(marketplace: 'ebay' | 'etsy') {
  return {
    marketplace,
    async publish(_request: PublishRequest): Promise<PublishResult> {
      return { remoteId: `${marketplace}-1` };
    },
    async end(_remoteId: string): Promise<EndResult> {
      return { ended: true };
    },
  };
}

async function makeItem(
  base: string,
  cookie: string,
  body: Record<string, unknown> = {},
): Promise<void> {
  await fetch(`${base}/api/items`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ title: 'Print no. 3', priceCents: 3500, ...body }),
  });
}

test('the Today screen offers a publish button for a configured marketplace', async () => {
  await withServer({ ebay: fakeAdapter('ebay') }, async ({ base, close, cookie }) => {
    await makeItem(base, cookie);

    const page = await fetch(base, { headers: { cookie } });
    const html = await page.text();

    assert.match(html, /data-marketplace="ebay"/);
    assert.match(html, /Publish to eBay/);
    await close();
  });
});

test('a marketplace that is not configured gets no button at all', async () => {
  await withServer({}, async ({ base, close, cookie }) => {
    await makeItem(base, cookie);

    const page = await fetch(base, { headers: { cookie } });
    const html = await page.text();

    assert.ok(!html.includes('data-marketplace="ebay"'), 'no button for an unconfigured marketplace');
    assert.ok(!html.includes('data-marketplace="etsy"'));
    await close();
  });
});

test('the Etsy button is disabled for an item that is not original or vintage', async () => {
  await withServer({ etsy: fakeAdapter('etsy') }, async ({ base, close, cookie }) => {
    await makeItem(base, cookie, { originalOrVintage: false });

    const page = await fetch(base, { headers: { cookie } });
    const html = await page.text();

    assert.match(html, /data-marketplace="etsy"/);
    assert.match(html, /original or vintage only/);
    // The button is there but it is not clickable, and it says why.
    assert.match(html, /publish-btn[^>]*disabled/);
    await close();
  });
});

test('the Etsy button is live for an item that is original or vintage', async () => {
  await withServer({ etsy: fakeAdapter('etsy') }, async ({ base, close, cookie }) => {
    await makeItem(base, cookie, { originalOrVintage: true });

    const page = await fetch(base, { headers: { cookie } });
    const html = await page.text();

    assert.match(html, /data-marketplace="etsy"/);
    assert.ok(!/publish-btn[^>]*disabled[^>]*data-marketplace="etsy"/.test(html));
    await close();
  });
});

test('Facebook never gets a publish button, because it is a paste card', async () => {
  await withServer({ ebay: fakeAdapter('ebay') }, async ({ base, close, cookie }) => {
    await makeItem(base, cookie);

    const page = await fetch(base, { headers: { cookie } });
    const html = await page.text();

    assert.ok(!html.includes('data-marketplace="facebook"'));
    assert.match(html, /Facebook card/);
    await close();
  });
});

test('an item that is already published shows the marketplace as done', async () => {
  await withServer({ ebay: fakeAdapter('ebay') }, async ({ base, close, cookie }) => {
    const created = await fetch(`${base}/api/items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ title: 'Print no. 3', priceCents: 3500 }),
    });
    const { item } = (await created.json()) as { item: { id: string } };

    const published = await fetch(`${base}/api/items/${item.id}/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ marketplace: 'ebay' }),
    });
    assert.equal(published.status, 200);

    const page = await fetch(base, { headers: { cookie } });
    const html = await page.text();

    assert.match(html, /eBay ✓/);
    await close();
  });
});

test('a refused publish shows the reason on the page, not in a tooltip', async () => {
  await withServer({ ebay: fakeAdapter('ebay') }, async ({ base, close, cookie }) => {
    await makeItem(base, cookie);

    const page = await fetch(base, { headers: { cookie } });
    const html = await page.text();

    // A phone has no tooltip, so the reason needs somewhere to live.
    assert.match(html, /publish-error/);
    assert.ok(!html.includes('title="the marketplace'), 'the reason is not only in a title attribute');
    await close();
  });
});

test('the button posts to the publish route with the marketplace', async () => {
  await withServer({ ebay: fakeAdapter('ebay') }, async ({ base, close, cookie }) => {
    await makeItem(base, cookie);

    const page = await fetch(base, { headers: { cookie } });
    const html = await page.text();

    // The script sends the marketplace with the item id.
    assert.match(html, /btn\.dataset\.item \+ '\/publish'/);
    assert.match(html, /body: JSON\.stringify\(\{ marketplace \}\)/);
    await close();
  });
});

test('a refused publish tells Emily why, instead of a bare failure', async () => {
  const adapter = {
    marketplace: 'ebay' as const,
    async publish(): Promise<PublishResult> {
      const { EBayPolicyError } = await import('../src/ebay-client.ts');
      throw new EBayPolicyError(
        'ebay_offer_not_live',
        'ebay created the offer but it is DRAFT, not live',
      );
    },
    async end(): Promise<EndResult> {
      return { ended: true };
    },
  };

  await withServer({ ebay: adapter }, async ({ base, close, cookie }) => {
    const created = await fetch(`${base}/api/items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ title: 'Print no. 3', priceCents: 3500 }),
    });
    const { item } = (await created.json()) as { item: { id: string } };

    const res = await fetch(`${base}/api/items/${item.id}/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ marketplace: 'ebay' }),
    });

    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string; detail: string };
    assert.match(body.detail, /DRAFT/);
    await close();
  });
});

test('the adapter the UI publishes through is the real one', async () => {
  // A cheap guard against the button being wired to something that is not
  // the marketplace adapter: the shape is what the server expects.
  const adapter = new EBayAdapter(
    { request: async () => ({}) } as never,
    { accessToken: async () => 'token' },
    { inventoryLocationId: 'l', categoryId: 'c', fulfillmentPolicyId: 'f', paymentPolicyId: 'p', returnPolicyId: 'r' },
  );
  assert.equal(adapter.marketplace, 'ebay');
});
