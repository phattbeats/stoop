import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Ledger } from '../src/ledger.ts';
import { createApp, listen, type Session } from '../src/server.ts';

function ledger(): Ledger {
  const book = new Ledger({ now: () => '2026-11-14T12:00:00.000Z' });
  book.addSeller({ id: 'seller_emily', authUserId: 'auth-uuid-1', displayName: 'Emily' });
  return book;
}

async function withServer(
  run: (ctx: { base: string; close: () => Promise<void>; cookie: string }) => Promise<void>,
): Promise<void> {
  const sessions: Record<string, Session> = {
    'emily-token': { authUserId: 'auth-emily', displayName: 'Emily' },
    'other-token': { authUserId: 'auth-other', displayName: 'Someone Else' },
  };
  const { server } = createApp({
    verifySession: (token) => (token ? sessions[token] ?? null : null),
  });
  const { port, close } = await listen(server);
  await run({ base: `http://127.0.0.1:${port}`, close, cookie: 'stoop_session=emily-token' });
}

test('"Posted on FB" records a state, not a Facebook id', () => {
  const book = ledger();
  const item = book.createItem({
    sellerId: 'seller_emily',
    title: 'Print no. 3',
    priceCents: 3500,
    condition: 'good',
    originalOrVintage: true,
  });

  const listing = book.markPostedOnFacebook(item.id);
  assert.equal(listing.marketplace, 'facebook');
  assert.equal(listing.remoteId, null, 'Stoop never touches Facebook, so there is no id to hold');
  assert.equal(listing.state, 'live');
  assert.equal(book.getItem(item.id)?.status, 'published');

  // It stays the same listing when she says it again.
  const again = book.markPostedOnFacebook(item.id);
  assert.equal(again.id, listing.id);
});

test('the app cannot publish to Facebook: the paste card is the only way there', () => {
  const book = ledger();
  const item = book.createItem({ sellerId: 'seller_emily', title: 'Print no. 3', priceCents: 3500 });
  assert.throws(() => book.publish(item.id, 'facebook', null), /paste card/);
  assert.equal(book.listListings(item.id).length, 0);
});

test('marking it sold ends every other listing and keeps the Facebook one', () => {
  const book = ledger();
  const item = book.createItem({ sellerId: 'seller_emily', title: 'Print no. 3', priceCents: 3500 });
  book.publish(item.id, 'ebay', 'ebay-offer-1');
  book.publish(item.id, 'etsy', 'etsy-listing-1');
  const facebook = book.markPostedOnFacebook(item.id);

  const result = book.markSold(item.id, 'manual-1');
  assert.equal(result.outcome, 'sale_recorded');
  assert.deepEqual(
    result.endedListings.map((l) => l.marketplace).sort(),
    ['ebay', 'etsy'],
    'the other channels end with no human in the loop',
  );
  assert.equal(book.getItem(item.id)?.status, 'sold');

  const listings = book.listListings(item.id);
  const fb = listings.find((l) => l.marketplace === 'facebook');
  assert.equal(fb?.id, facebook.id);
  assert.equal(fb?.state, 'live', 'the listing that sold is the winner and is left alone');
});

test('a second real-world sale is recorded as a refund, not dropped', () => {
  const book = ledger();
  const item = book.createItem({ sellerId: 'seller_emily', title: 'Print no. 3', priceCents: 3500 });
  book.publish(item.id, 'ebay', 'ebay-offer-1');
  book.markPostedOnFacebook(item.id);

  const first = book.recordSale({
    eventId: 'evt-ebay',
    marketplace: 'ebay',
    orderId: 'order-ebay',
    itemId: item.id,
    amountCents: 3500,
    occurredAt: '2026-11-14T12:00:00.000Z',
    receipt: { orderId: 'order-ebay' },
  });
  assert.equal(first.outcome, 'sale_recorded');

  // She also sold it on Facebook. The money moved; the item did not.
  const second = book.markSold(item.id, 'manual-1');
  assert.equal(second.outcome, 'suppressed_duplicate_sale');
  assert.equal(second.needsRefund, true);
  assert.equal(book.getDuplicateSales(item.id).length, 1);
  assert.equal(book.getDuplicateSales(item.id)[0].marketplace, 'facebook');
});

test('an item that is live on eBay is frozen: the record it was published from stays true', () => {
  const book = ledger();
  const item = book.createItem({
    sellerId: 'seller_emily',
    title: 'Print no. 3',
    priceCents: 3500,
    condition: 'good',
  });
  book.publish(item.id, 'ebay', 'ebay-offer-1');
  assert.throws(() => book.updateItem(item.id, { condition: 'fair' }), /live on another marketplace/);

  // Before anything is published, the facts can still be corrected.
  const draft = book.createItem({
    sellerId: 'seller_emily',
    title: 'Chair',
    priceCents: 12000,
    condition: 'unspecified',
  });
  const updated = book.updateItem(draft.id, { condition: 'fair', originalOrVintage: false });
  assert.equal(updated.condition, 'fair');
  assert.equal(updated.originalOrVintage, false);
});

test('over HTTP: the card, the posted tap and the mark-sold tap', async () => {
  await withServer(async ({ base, close, cookie }) => {
    const created = await fetch(`${base}/api/items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        title: 'Print no. 3',
        priceCents: 3500,
        condition: 'good',
        originalOrVintage: true,
      }),
    });
    assert.equal(created.status, 201);
    const { item } = (await created.json()) as { item: { id: string } };

    // The card comes from the item record, so it is ready to paste.
    const card = await fetch(`${base}/api/items/${item.id}/facebook-card`, { headers: { cookie } });
    assert.equal(card.status, 200);
    const { card: rendered } = (await card.json()) as {
      card: { text: string; ready: boolean; photoNote: string };
    };
    assert.equal(rendered.ready, true);
    assert.match(rendered.text, /\$35\.00/);
    assert.match(rendered.text, /^Condition: good$/m);
    assert.match(rendered.photoNote, /does not host them/i);

    // Another seller cannot read it.
    const stolen = await fetch(`${base}/api/items/${item.id}/facebook-card`, {
      headers: { cookie: 'stoop_session=other-token' },
    });
    assert.equal(stolen.status, 404);

    // She pastes it into Facebook and says so.
    const posted = await fetch(`${base}/api/items/${item.id}/facebook/posted`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: '{}',
    });
    assert.equal(posted.status, 200);
    const { listing } = (await posted.json()) as {
      listing: { marketplace: string; remoteId: string | null; state: string };
    };
    assert.equal(listing.marketplace, 'facebook');
    assert.equal(listing.remoteId, null);
    assert.equal(listing.state, 'live');

    // Facebook is not a publish target.
    const publish = await fetch(`${base}/api/items/${item.id}/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ marketplace: 'facebook' }),
    });
    assert.equal(publish.status, 400);
    assert.deepEqual(await publish.json(), { error: 'facebook_requires_paste_card' });

    // And the sale ends everything else with no human in the loop.
    const sold = await fetch(`${base}/api/items/${item.id}/mark-sold`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: '{}',
    });
    assert.equal(sold.status, 200);
    const result = (await sold.json()) as { outcome: string; needsRefund: boolean };
    assert.equal(result.outcome, 'sale_recorded');
    assert.equal(result.needsRefund, false);

    const today = await fetch(`${base}/api/today`, { headers: { cookie } });
    const body = (await today.json()) as {
      items: { sold: boolean; postedOnFacebook: boolean; card: { ready: boolean } }[];
    };
    assert.equal(body.items[0].sold, true);
    assert.equal(body.items[0].postedOnFacebook, true);
    await close();
  });
});

test('over HTTP: a card with no condition is blocked, and she can fix it from the phone', async () => {
  await withServer(async ({ base, close, cookie }) => {
    const created = await fetch(`${base}/api/items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ title: 'Chair', priceCents: 12000 }),
    });
    const { item } = (await created.json()) as { item: { id: string } };

    const blocked = await fetch(`${base}/api/items/${item.id}/facebook-card`, { headers: { cookie } });
    const { card } = (await blocked.json()) as {
      card: { ready: boolean; blockers: string[]; text: string };
    };
    assert.equal(card.ready, false);
    assert.ok(card.blockers.includes('condition_missing'));

    const fixed = await fetch(`${base}/api/items/${item.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ condition: 'fair', originalOrVintage: false }),
    });
    assert.equal(fixed.status, 200);
    const { card: after } = (await fixed.json()) as { card: { ready: boolean; text: string } };
    assert.equal(after.ready, true);
    assert.match(after.text, /^Condition: fair$/m);
    assert.match(after.text, /^Original or vintage: no$/m);
    await close();
  });
});
