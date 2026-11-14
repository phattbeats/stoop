/**
 * The Postgres store against a real database.
 *
 * Skipped unless STOOP_DATABASE_URL is set, so CI stays dependency-free.
 * On vps1: STOOP_DATABASE_URL=postgres://stoop:***@postgres/stoop_test
 * with the schema applied (node src/migrate.ts).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Pool } from 'pg';
import { Ledger } from '../src/ledger.ts';
import { PgLedger } from '../src/store.ts';
import { PgEtsyTokenStore, PgRemoteActionStore } from '../src/etsy-store.ts';

const databaseUrl = process.env.STOOP_DATABASE_URL;
const integration = databaseUrl ? test : test.skip;

integration('the Postgres store keeps the same invariants as the in-memory ledger', async (t) => {
  const pool = new Pool({ connectionString: databaseUrl });
  const store = new PgLedger(pool);
  const reference = new Ledger();

  const stamp = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const seller = await store.addSeller({ id: 'ignored', authUserId: `auth-${stamp}`, displayName: 'Emily' });
  const other = await store.addSeller({ id: 'ignored', authUserId: `other-${stamp}`, displayName: 'Someone' });
  reference.addSeller({ id: seller.id, authUserId: seller.authUserId, displayName: seller.displayName });

  t.after(async () => {
    await pool.query(`DELETE FROM sellers WHERE auth_user_id LIKE $1`, [`%${stamp}`]);
    await pool.end();
  });

  const item = await store.createItem({
    sellerId: seller.id,
    title: 'Print no. 3',
    priceCents: 3500,
    tags: ['Print', 'print', 'art'],
  });
  assert.equal(item.status, 'draft');
  assert.deepEqual(item.tags, ['print', 'art'], 'tags are normalized and de-duped');

  const refItem = reference.createItem({
    sellerId: seller.id,
    title: 'Print no. 3',
    priceCents: 3500,
  });

  const ebay = await store.publish(item.id, 'ebay', 'ebay-offer-1');
  const etsy = await store.publish(item.id, 'etsy', 'etsy-listing-1');
  assert.equal(ebay.state, 'live');
  assert.equal(etsy.state, 'live');

  // Publishing again revises in place: one listing per (item, marketplace).
  const revised = await store.publish(item.id, 'ebay', 'ebay-offer-2');
  assert.equal(revised.id, ebay.id);
  assert.equal(revised.remoteId, 'ebay-offer-2');
  assert.equal((await store.listListings(item.id)).length, 2);

  // No receipt, no stock movement.
  await assert.rejects(
    () =>
      store.recordSale({
        eventId: `evt-${stamp}-noreceipt`,
        marketplace: 'ebay',
        orderId: 'order-x',
        itemId: item.id,
        amountCents: 3500,
        occurredAt: new Date().toISOString(),
        receipt: null,
      }),
    /receipt required/,
  );
  assert.equal(await store.isSold(item.id), false);

  // The break test: bought on eBay and Etsy inside 60 s.
  const first = await store.recordSale({
    eventId: `evt-${stamp}-ebay`,
    marketplace: 'ebay',
    orderId: `order-${stamp}-ebay`,
    itemId: item.id,
    amountCents: 3500,
    occurredAt: new Date().toISOString(),
    receipt: { orderId: `order-${stamp}-ebay` },
  });
  assert.equal(first.outcome, 'sale_recorded');
  assert.equal(first.endedListings.length, 1);
  assert.equal(first.endedListings[0].marketplace, 'etsy');
  assert.equal(first.endedListings[0].endReason, 'sold_on_ebay');
  assert.equal((await store.getItem(item.id))?.status, 'sold');

  const second = await store.recordSale({
    eventId: `evt-${stamp}-etsy`,
    marketplace: 'etsy',
    orderId: `order-${stamp}-etsy`,
    itemId: item.id,
    amountCents: 3500,
    occurredAt: new Date().toISOString(),
    receipt: { orderId: `order-${stamp}-etsy` },
  });
  assert.equal(second.outcome, 'suppressed_duplicate_sale');
  assert.equal(second.needsRefund, true);
  assert.equal((await store.getDuplicateSales(item.id)).length, 1);

  // A redelivered webhook changes nothing.
  const redelivered = await store.recordSale({
    eventId: `evt-${stamp}-ebay`,
    marketplace: 'ebay',
    orderId: `order-${stamp}-ebay`,
    itemId: item.id,
    amountCents: 3500,
    occurredAt: new Date().toISOString(),
    receipt: { orderId: `order-${stamp}-ebay` },
  });
  assert.equal(redelivered.outcome, 'ignored_duplicate_webhook');

  // A sold item cannot be republished.
  await assert.rejects(() => store.publish(item.id, 'facebook', null), /is sold/);

  // Multi-tenant: another seller's items are not visible.
  const otherItem = await store.createItem({ sellerId: other.id, title: 'Chair', priceCents: 12000 });
  const mine = await store.listItems(seller.id);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].id, item.id);
  assert.equal(await store.getItem(otherItem.id) !== undefined, true);

  // The in-memory reference ledger reaches the same conclusions.
  reference.publish(refItem.id, 'ebay', 'ebay-offer-1');
  reference.publish(refItem.id, 'etsy', 'etsy-listing-1');
  const refFirst = reference.recordSale({
    eventId: `evt-${stamp}-ebay`,
    marketplace: 'ebay',
    orderId: `order-${stamp}-ebay`,
    itemId: refItem.id,
    amountCents: 3500,
    occurredAt: new Date().toISOString(),
    receipt: { orderId: `order-${stamp}-ebay` },
  });
  const refSecond = reference.recordSale({
    eventId: `evt-${stamp}-etsy`,
    marketplace: 'etsy',
    orderId: `order-${stamp}-etsy`,
    itemId: refItem.id,
    amountCents: 3500,
    occurredAt: new Date().toISOString(),
    receipt: { orderId: `order-${stamp}-etsy` },
  });
  assert.equal(refFirst.outcome, first.outcome);
  assert.equal(refSecond.outcome, second.outcome);
  assert.equal(refFirst.endedListings.length, first.endedListings.length);
  assert.equal(reference.getDuplicateSales(refItem.id).length, 1);
});

integration('the Postgres store keeps the Facebook paste-card rules', async (t) => {
  const pool = new Pool({ connectionString: databaseUrl });
  const store = new PgLedger(pool);

  const stamp = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const seller = await store.addSeller({ id: 'ignored', authUserId: `auth-${stamp}`, displayName: 'Emily' });

  t.after(async () => {
    await pool.query(`DELETE FROM sellers WHERE auth_user_id LIKE $1`, [`%${stamp}`]);
    await pool.end();
  });

  const item = await store.createItem({
    sellerId: seller.id,
    title: 'Print no. 3',
    priceCents: 3500,
    condition: 'good',
    originalOrVintage: true,
  });
  assert.equal(item.condition, 'good');
  assert.equal(item.originalOrVintage, true);

  // Facebook is a state, not an id: there is no Facebook listing id to hold.
  const facebook = await store.markPostedOnFacebook(item.id);
  assert.equal(facebook.marketplace, 'facebook');
  assert.equal(facebook.remoteId, null);
  assert.equal(facebook.state, 'live');

  // The app cannot publish to Facebook.
  await assert.rejects(() => store.publish(item.id, 'facebook', null), /paste card/);

  await store.publish(item.id, 'ebay', 'ebay-offer-1');
  await store.publish(item.id, 'etsy', 'etsy-listing-1');

  // The sale wins: the other listings end with no human in the loop, and the
  // listing that sold is left alone.
  const sold = await store.markSold(item.id, `manual-${stamp}`);
  assert.equal(sold.outcome, 'sale_recorded');
  assert.deepEqual(
    sold.endedListings.map((l) => l.marketplace).sort(),
    ['ebay', 'etsy'],
  );
  const listings = await store.listListings(item.id);
  const fb = listings.find((l) => l.marketplace === 'facebook');
  assert.equal(fb?.state, 'live');
  assert.equal(fb?.remoteId, null);

  // A second real-world sale is recorded as a refund, not dropped.
  const other = await store.createItem({ sellerId: seller.id, title: 'Chair', priceCents: 12000 });
  await store.publish(other.id, 'ebay', 'ebay-offer-2');
  await store.markPostedOnFacebook(other.id);
  const first = await store.recordSale({
    eventId: `evt-${stamp}-ebay`,
    marketplace: 'ebay',
    orderId: `order-${stamp}-ebay`,
    itemId: other.id,
    amountCents: 12000,
    occurredAt: new Date().toISOString(),
    receipt: { orderId: `order-${stamp}-ebay` },
  });
  assert.equal(first.outcome, 'sale_recorded');
  const second = await store.markSold(other.id, `manual-${stamp}-second`);
  assert.equal(second.outcome, 'suppressed_duplicate_sale');
  assert.equal(second.needsRefund, true);
  const duplicates = await store.getDuplicateSales(other.id);
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0].marketplace, 'facebook');
});

integration('the Postgres store finds a listing by the id a marketplace names', async (t) => {
  const pool = new Pool({ connectionString: databaseUrl });
  const store = new PgLedger(pool);
  const reference = new Ledger();

  const stamp = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const seller = await store.addSeller({ id: 'ignored', authUserId: `auth-${stamp}`, displayName: 'Emily' });
  const refSeller = reference.addSeller({
    id: seller.id,
    authUserId: seller.authUserId,
    displayName: seller.displayName,
  });

  t.after(async () => {
    await pool.query(`DELETE FROM sellers WHERE auth_user_id LIKE $1`, [`%${stamp}`]);
    await pool.end();
  });

  const item = await store.createItem({ sellerId: seller.id, title: 'Print no. 3', priceCents: 3500 });
  const refItem = reference.createItem({ sellerId: refSeller.id, title: 'Print no. 3', priceCents: 3500 });
  await store.publish(item.id, 'etsy', 'etsy-listing-1');
  await store.publish(item.id, 'ebay', 'ebay-offer-1');
  reference.publish(refItem.id, 'etsy', 'etsy-listing-1');
  reference.publish(refItem.id, 'ebay', 'ebay-offer-1');

  // The way a marketplace event finds its item: by the remote id, not ours.
  const found = await store.findListingByRemoteId('etsy', 'etsy-listing-1');
  const refFound = reference.findListingByRemoteId('etsy', 'etsy-listing-1');
  assert.equal(found?.itemId, item.id);
  assert.equal(refFound?.itemId, refItem.id);
  assert.equal(await store.findListingByRemoteId('etsy', 'nope'), undefined);
  assert.equal(reference.findListingByRemoteId('etsy', 'nope'), undefined);
});

integration('the Postgres Etsy token store and remote action queue behave', async (t) => {
  const pool = new Pool({ connectionString: databaseUrl });
  const tokens = new PgEtsyTokenStore(pool);
  const actions = new PgRemoteActionStore(pool);

  const stamp = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ledger = new PgLedger(pool);
  const seller = await ledger.addSeller({ id: 'ignored', authUserId: `auth-${stamp}`, displayName: 'Emily' });

  t.after(async () => {
    await pool.query(`DELETE FROM sellers WHERE auth_user_id LIKE $1`, [`%${stamp}`]);
    await pool.end();
  });

  // Tokens: saved, found by seller and by shop, and re-consented before they die.
  const saved = await tokens.save(seller.id, {
    accessToken: '12345678.token',
    refreshToken: '12345678.refresh',
    expiresIn: 3600,
    scope: 'listings_w transactions_r',
    shopId: '42',
  });
  assert.equal(saved.shopId, '42');
  assert.ok(Date.parse(saved.accessExpiresAt) > Date.now());
  assert.ok(Date.parse(saved.refreshExpiresAt) > Date.parse(saved.accessExpiresAt));
  assert.equal((await tokens.get(seller.id))?.refreshToken, '12345678.refresh');
  assert.equal((await tokens.getByShopId('42'))?.sellerId, seller.id);
  assert.equal((await tokens.first())?.sellerId, seller.id);

  // The same action twice is still one action.
  const item = await ledger.createItem({ sellerId: seller.id, title: 'Print no. 3', priceCents: 3500 });
  const listing = await ledger.publish(item.id, 'etsy', 'etsy-listing-1');
  const first = await actions.enqueue({
    itemId: item.id,
    listingId: listing.id,
    marketplace: 'etsy',
    action: 'delist',
    remoteId: 'etsy-listing-1',
  });
  const again = await actions.enqueue({
    itemId: item.id,
    listingId: listing.id,
    marketplace: 'etsy',
    action: 'delist',
    remoteId: 'etsy-listing-1',
  });
  assert.equal(again.id, first.id);

  // A failed remote delist stays visible for a human.
  await actions.markFailed(first.id, 'etsy said no');
  const open = await actions.listOpen();
  const failed = open.find((a) => a.id === first.id);
  assert.equal(failed?.state, 'needs_human');
  assert.equal(failed?.needsHuman, true);
  assert.equal(failed?.lastError, 'etsy said no');
  assert.equal(failed?.attempts, 1);

  // And a successful one is finished with.
  await actions.markSucceeded(first.id, { alreadyGone: true });
  const stillOpen = await actions.listOpen();
  assert.equal(stillOpen.find((a) => a.id === first.id), undefined);
});
