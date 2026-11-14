import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Ledger } from '../src/ledger.ts';

function ledger(): Ledger {
  const book = new Ledger({ now: () => '2026-11-14T12:00:00.000Z' });
  book.addSeller({ id: 'seller_emily', authUserId: 'auth-uuid-1', displayName: 'Emily' });
  return book;
}

test('one item, two marketplaces, one sale: the other listing is auto-cancelled', () => {
  const book = ledger();
  const item = book.createItem({ sellerId: 'seller_emily', title: 'Print no. 3', priceCents: 3500 });
  book.publish(item.id, 'ebay', 'ebay-offer-1');
  book.publish(item.id, 'etsy', 'etsy-listing-1');

  const result = book.recordSale({
    eventId: 'evt-1',
    marketplace: 'ebay',
    orderId: 'order-1',
    itemId: item.id,
    amountCents: 3500,
    occurredAt: '2026-11-14T12:00:00.000Z',
    receipt: { orderId: 'order-1', lineItems: [{ itemId: item.id }] },
  });

  assert.equal(result.outcome, 'sale_recorded');
  assert.equal(result.endedListings.length, 1);
  assert.equal(result.endedListings[0].marketplace, 'etsy');
  assert.equal(result.endedListings[0].endReason, 'sold_on_ebay');
  assert.equal(book.getItem(item.id)?.status, 'sold');
  assert.equal(book.isSold(item.id), true);
});

test('break test: bought on eBay and Etsy inside 60s -> exactly one sale, one auto-cancel', () => {
  const book = ledger();
  const item = book.createItem({ sellerId: 'seller_emily', title: 'Print no. 3', priceCents: 3500 });
  book.publish(item.id, 'ebay', 'ebay-offer-1');
  book.publish(item.id, 'etsy', 'etsy-listing-1');

  const first = book.recordSale({
    eventId: 'evt-ebay',
    marketplace: 'ebay',
    orderId: 'order-ebay',
    itemId: item.id,
    amountCents: 3500,
    occurredAt: '2026-11-14T12:00:00.000Z',
    receipt: { orderId: 'order-ebay' },
  });
  const second = book.recordSale({
    eventId: 'evt-etsy',
    marketplace: 'etsy',
    orderId: 'order-etsy',
    itemId: item.id,
    amountCents: 3500,
    occurredAt: '2026-11-14T12:00:40.000Z',
    receipt: { orderId: 'order-etsy' },
  });

  assert.equal(first.outcome, 'sale_recorded');
  assert.equal(first.endedListings.length, 1);
  assert.equal(second.outcome, 'suppressed_duplicate_sale');
  assert.equal(second.endedListings.length, 0);

  // exactly one recorded sale for the item
  assert.equal(book.getSale(item.id)?.marketplace, 'ebay');
  // the loser is recorded, not dropped: the money moved, so it needs a refund
  assert.equal(second.needsRefund, true);
  assert.equal(book.getDuplicateSales(item.id).length, 1);
});

test('a redelivered webhook changes nothing', () => {
  const book = ledger();
  const item = book.createItem({ sellerId: 'seller_emily', title: 'Print no. 3', priceCents: 3500 });
  book.publish(item.id, 'ebay', 'ebay-offer-1');
  book.publish(item.id, 'etsy', 'etsy-listing-1');

  const signal = {
    eventId: 'evt-1',
    marketplace: 'ebay' as const,
    orderId: 'order-1',
    itemId: item.id,
    amountCents: 3500,
    occurredAt: '2026-11-14T12:00:00.000Z',
    receipt: { orderId: 'order-1' },
  };
  const first = book.recordSale(signal);
  const second = book.recordSale(signal);

  assert.equal(first.outcome, 'sale_recorded');
  assert.equal(second.outcome, 'ignored_duplicate_webhook');
  assert.equal(second.endedListings.length, 0);
  assert.equal(book.getDuplicateSales(item.id).length, 0);
});

test('no receipt, no stock movement', () => {
  const book = ledger();
  const item = book.createItem({ sellerId: 'seller_emily', title: 'Print no. 3', priceCents: 3500 });
  book.publish(item.id, 'etsy', 'etsy-listing-1');

  assert.throws(
    () =>
      book.recordSale({
        eventId: 'evt-1',
        marketplace: 'etsy',
        orderId: 'order-1',
        itemId: item.id,
        amountCents: 3500,
        occurredAt: '2026-11-14T12:00:00.000Z',
        receipt: null,
      }),
    /receipt required/,
  );
  assert.equal(book.isSold(item.id), false);
  assert.equal(book.getItem(item.id)?.status, 'published');
  // and the listing is still live, so the sale can still be applied
  assert.equal(book.listListings(item.id)[0].state, 'live');
});

test('one listing per marketplace per item: publishing again revises in place', () => {
  const book = ledger();
  const item = book.createItem({ sellerId: 'seller_emily', title: 'Print no. 3', priceCents: 3500 });
  const first = book.publish(item.id, 'ebay', 'ebay-offer-1');
  const second = book.publish(item.id, 'ebay', 'ebay-offer-2');

  assert.equal(first.id, second.id);
  assert.equal(second.remoteId, 'ebay-offer-2');
  assert.equal(book.listListings(item.id).length, 1);
});

test('a sold item cannot be republished', () => {
  const book = ledger();
  const item = book.createItem({ sellerId: 'seller_emily', title: 'Print no. 3', priceCents: 3500 });
  book.publish(item.id, 'ebay', 'ebay-offer-1');
  book.markSold(item.id, 'manual-1');
  assert.throws(() => book.publish(item.id, 'etsy', 'etsy-listing-1'), /is sold/);
});

test('multi-tenant: a seller never sees another seller\'s items', () => {
  const book = ledger();
  book.addSeller({ id: 'seller_other', authUserId: 'auth-uuid-2', displayName: 'Someone Else' });
  const emilyItem = book.createItem({ sellerId: 'seller_emily', title: 'Print no. 3', priceCents: 3500 });
  book.createItem({ sellerId: 'seller_other', title: 'Chair', priceCents: 12000 });

  const emilyItems = book.listItems('seller_emily');
  assert.equal(emilyItems.length, 1);
  assert.equal(emilyItems[0].id, emilyItem.id);
});
