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
  assert.deepEqual(item.tags, ['print'], 'tags are normalized and de-duped');

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
