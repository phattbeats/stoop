/**
 * Stoop — the rules, storage-agnostic.
 *
 * Types live in src/ledger.ts (the in-memory reference implementation). This
 * module holds the pure decisions that both the reference ledger and the
 * Postgres store (src/store.ts) must agree on, so the anti-double-sale rule
 * cannot drift between them. test/store.test.ts cross-checks the two against
 * the same break-test scenario.
 *
 * The rules are the product. The phone shell is a skin over them.
 */

import type { Item, Listing, ListingState, Marketplace, Sale } from './ledger.ts';

export const MARKETPLACES: readonly Marketplace[] = ['ebay', 'etsy', 'facebook'];

/**
 * There is no Facebook listing id, because Stoop never touches Facebook.
 *
 * The Facebook path is a paste card and a tap. A listing on Facebook is a
 * *state* (she posted it), not a remote resource we hold an id for, so
 * `remote_id` stays null and stays null forever.
 */
export const FACEBOOK_REMOTE_ID: string | null = null;

/**
 * Facebook is not a publishable channel.
 *
 * The card is the only way an item reaches Facebook, and "Posted on FB" is
 * the only way the app learns about it. Publishing there would claim a
 * listing Stoop did not create and cannot manage.
 */
export function assertNotFacebookPublish(marketplace: Marketplace): void {
  if (marketplace === 'facebook') {
    throw new Error('facebook is a paste card: mark it posted instead of publishing');
  }
}

/**
 * An item may be edited only while no channel the app publishes to is live.
 *
 * eBay Inventory-API listings cannot be revised in Seller Hub, so once an
 * item is on eBay or Etsy the record it was published from is frozen —
 * otherwise the app would be holding a record that no longer matches the
 * listing a buyer can see. A Facebook paste card does not freeze anything:
 * Emily edits the Facebook post herself.
 */
export function assertEditable(item: Pick<Item, 'id' | 'status'>, listings: Listing[]): void {
  if (item.status === 'sold') {
    throw new Error(`item ${item.id} is sold; it cannot be edited`);
  }
  const liveElsewhere = listings.some(
    (l) => l.itemId === item.id && l.state !== 'ended' && l.marketplace !== 'facebook',
  );
  if (liveElsewhere) {
    throw new Error(`item ${item.id} is live on another marketplace; it cannot be edited`);
  }
}

/**
 * A sale needs a receipt. We do not decrement stock because a webhook arrived;
 * we decrement it because a receipt says sold.
 */
export function requireReceipt(receipt: Record<string, unknown> | null, eventId: string): Record<string, unknown> {
  if (!receipt || Object.keys(receipt).length === 0) {
    throw new Error(
      `receipt required before recording a sale (event ${eventId}): ` +
        'fetch it from the marketplace resource_url first',
    );
  }
  return receipt;
}

/** A sold item is done. It cannot be published again. */
export function assertPublishable(item: Pick<Item, 'id' | 'status'>): void {
  if (item.status === 'sold') {
    throw new Error(`item ${item.id} is sold; it cannot be published`);
  }
}

/**
 * Which listings a sale on `soldOn` must end.
 *
 * The sale ends every *other* live listing for the item, on any marketplace.
 * The listing on the marketplace that sold is left alone: it is the winner.
 */
export function listingsEndedBySale(
  listings: Listing[],
  itemId: string,
  soldOn: Marketplace,
  endedAt: string,
): Listing[] {
  return listings
    .filter((l) => l.itemId === itemId && l.state !== 'ended' && l.marketplace !== soldOn)
    .map((l) => ({
      ...l,
      state: 'ended' as ListingState,
      endedAt,
      endReason: `sold_on_${soldOn}`,
    }));
}

/**
 * The duplicate-sale rule.
 *
 * The first valid sale wins. A later real-world sale on another marketplace is
 * recorded, not dropped: the money moved even though the item did not, so it
 * needs a refund.
 */
export function saleDecision(existingSale: Sale | undefined): 'record' | 'suppress_duplicate' {
  return existingSale ? 'suppress_duplicate' : 'record';
}

/**
 * Publishing again revises in place: there is never more than one listing per
 * (item, marketplace). eBay Inventory-API listings cannot be revised in Seller
 * Hub, so the API is the only editor.
 */
export function listingKey(itemId: string, marketplace: Marketplace): string {
  return `${itemId}::${marketplace}`;
}

/** Normalize a client-supplied price to integer cents. Throws on nonsense. */
export function parsePriceCents(input: unknown): number {
  const value = typeof input === 'string' ? Number(input) : input;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('price must be a number');
  }
  const cents = Math.round(value * 100);
  if (cents < 0) throw new Error('price must not be negative');
  if (cents > 100_000_000) throw new Error('price is implausibly large');
  return cents;
}

/** Trim and cap a free-text field; returns '' for junk. */
export function cleanText(input: unknown, maxLength: number): string {
  if (typeof input !== 'string') return '';
  return input.trim().slice(0, maxLength);
}

/** Normalize a list of tags: trimmed, de-duped, capped. */
export function cleanTags(input: unknown, max = 12): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  for (const raw of input) {
    const tag = cleanText(raw, 40).toLowerCase();
    if (!tag || out.includes(tag)) continue;
    out.push(tag);
    if (out.length >= max) break;
  }
  return out;
}

/** Normalize photo references: de-duped, capped. */
export function cleanPhotos(input: unknown, max = 12): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  for (const raw of input) {
    const photo = cleanText(raw, 500);
    if (!photo || out.includes(photo)) continue;
    out.push(photo);
    if (out.length >= max) break;
  }
  return out;
}
