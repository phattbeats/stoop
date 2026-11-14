/**
 * Stoop — canonical inventory ledger.
 *
 * One record per item. Every marketplace listing is a projection of that record,
 * never the source of truth. A sale anywhere ends every other listing.
 *
 * The invariants in this file are the product. The phone shell is a skin over them.
 */

export type Marketplace = 'ebay' | 'etsy' | 'facebook';

export type ItemStatus = 'draft' | 'published' | 'sold' | 'ended';

export type ListingState = 'pending' | 'live' | 'ended';

export interface Seller {
  id: string;
  /** PHATT ID subject (Authentik user uuid). Multi-tenant key. */
  authUserId: string;
  displayName: string;
}

export interface Item {
  id: string;
  sellerId: string;
  title: string;
  description: string;
  priceCents: number;
  photos: string[];
  tags: string[];
  status: ItemStatus;
  createdAt: string;
}

export interface Listing {
  id: string;
  itemId: string;
  marketplace: Marketplace;
  /** eBay offer id / Etsy listing id / null for the Facebook paste card. */
  remoteId: string | null;
  state: ListingState;
  createdAt: string;
  endedAt?: string;
  endReason?: string;
}

export interface Sale {
  id: string;
  itemId: string;
  marketplace: Marketplace;
  orderId: string;
  amountCents: number;
  occurredAt: string;
  /** Receipt fetched from the marketplace (Etsy: resource_url) before stock moved. */
  receipt: Record<string, unknown>;
}

export type SaleOutcome =
  | 'sale_recorded'
  | 'suppressed_duplicate_sale'
  | 'ignored_duplicate_webhook';

export interface SaleResult {
  outcome: SaleOutcome;
  sale?: Sale;
  /** Listings auto-cancelled because this sale won. */
  endedListings: Listing[];
  /**
   * A second real-world sale on another marketplace. It is recorded, not dropped:
   * money changed hands and a human has to refund it.
   */
  needsRefund: boolean;
}

/** A sale signal as it arrives from a marketplace webhook or poll. */
export interface SaleSignal {
  /** Webhook id (Etsy) or poll cursor id. Idempotency key. */
  eventId: string;
  marketplace: Marketplace;
  orderId: string;
  itemId: string;
  amountCents: number;
  occurredAt: string;
  /**
   * The marketplace receipt/line item. Required: we do not decrement stock
   * because a webhook arrived, we decrement it because a receipt says sold.
   */
  receipt: Record<string, unknown> | null;
}

export interface LedgerOptions {
  now?: () => string;
}

function requireReceipt(signal: SaleSignal): Record<string, unknown> {
  if (!signal.receipt || Object.keys(signal.receipt).length === 0) {
    throw new Error(
      `receipt required before recording a sale (event ${signal.eventId}): ` +
        'fetch it from the marketplace resource_url first',
    );
  }
  return signal.receipt;
}

export class Ledger {
  private readonly sellers = new Map<string, Seller>();
  private readonly items = new Map<string, Item>();
  private readonly listings = new Map<string, Listing>();
  /** itemId -> the one sale that counts. */
  private readonly sales = new Map<string, Sale>();
  /** itemId -> real-world sales that lost the race. */
  private readonly duplicateSales = new Map<string, Sale[]>();
  /** eventId -> outcome, so a redelivered webhook changes nothing. */
  private readonly processedEvents = new Map<string, SaleOutcome>();
  private readonly now: () => string;
  private counter = 0;

  constructor(options: LedgerOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  private nextId(prefix: string): string {
    this.counter += 1;
    return `${prefix}_${this.counter.toString(36).padStart(4, '0')}`;
  }

  addSeller(seller: Seller): Seller {
    this.sellers.set(seller.id, seller);
    return seller;
  }

  getSeller(id: string): Seller | undefined {
    return this.sellers.get(id);
  }

  createItem(input: {
    sellerId: string;
    title: string;
    description?: string;
    priceCents: number;
    photos?: string[];
    tags?: string[];
  }): Item {
    if (!this.sellers.has(input.sellerId)) {
      throw new Error(`unknown seller ${input.sellerId}`);
    }
    const item: Item = {
      id: this.nextId('item'),
      sellerId: input.sellerId,
      title: input.title,
      description: input.description ?? '',
      priceCents: input.priceCents,
      photos: input.photos ?? [],
      tags: input.tags ?? [],
      status: 'draft',
      createdAt: this.now(),
    };
    this.items.set(item.id, item);
    return item;
  }

  getItem(id: string): Item | undefined {
    return this.items.get(id);
  }

  listItems(sellerId?: string): Item[] {
    const all = [...this.items.values()];
    return sellerId ? all.filter((i) => i.sellerId === sellerId) : all;
  }

  listListings(itemId?: string): Listing[] {
    const all = [...this.listings.values()];
    return itemId ? all.filter((l) => l.itemId === itemId) : all;
  }

  /**
   * Publish (or revise) the item on one marketplace.
   *
   * eBay Inventory-API listings cannot be revised in Seller Hub, so the API is the
   * only editor: publishing again with a new remote id revises in place. There is
   * never more than one listing per (item, marketplace).
   */
  publish(itemId: string, marketplace: Marketplace, remoteId: string | null): Listing {
    const item = this.items.get(itemId);
    if (!item) throw new Error(`unknown item ${itemId}`);
    if (item.status === 'sold') throw new Error(`item ${itemId} is sold; it cannot be published`);

    const existing = [...this.listings.values()].find(
      (l) => l.itemId === itemId && l.marketplace === marketplace && l.state !== 'ended',
    );
    if (existing) {
      existing.remoteId = remoteId ?? existing.remoteId;
      existing.state = 'live';
      return existing;
    }

    const listing: Listing = {
      id: this.nextId('lst'),
      itemId,
      marketplace,
      remoteId,
      state: 'live',
      createdAt: this.now(),
    };
    this.listings.set(listing.id, listing);
    item.status = 'published';
    return listing;
  }

  /** End one listing by hand (seller pulled it). */
  endListing(listingId: string, reason: string): Listing {
    const listing = this.listings.get(listingId);
    if (!listing) throw new Error(`unknown listing ${listingId}`);
    if (listing.state === 'ended') return listing;
    listing.state = 'ended';
    listing.endedAt = this.now();
    listing.endReason = reason;
    const item = this.items.get(listing.itemId);
    if (item && item.status === 'published') item.status = 'ended';
    return listing;
  }

  /**
   * Record a sale signal from a marketplace.
   *
   * Order of authority, and why:
   *  1. Idempotency first — a redelivered webhook must not move anything twice.
   *  2. Receipt second — we do not decrement stock because a webhook arrived.
   *  3. One sale per item — the first valid sale wins and auto-cancels the rest.
   *  4. A later real-world sale is recorded as a duplicate that needs a refund,
   *     never dropped silently: the money moved even though the item did not.
   */
  recordSale(signal: SaleSignal): SaleResult {
    const seen = this.processedEvents.get(signal.eventId);
    if (seen) {
      return { outcome: 'ignored_duplicate_webhook', endedListings: [], needsRefund: false };
    }

    const receipt = requireReceipt(signal);

    const item = this.items.get(signal.itemId);
    if (!item) throw new Error(`unknown item ${signal.itemId}`);

    const existingSale = this.sales.get(signal.itemId);
    if (existingSale) {
      const duplicate: Sale = {
        id: this.nextId('sale'),
        itemId: signal.itemId,
        marketplace: signal.marketplace,
        orderId: signal.orderId,
        amountCents: signal.amountCents,
        occurredAt: signal.occurredAt,
        receipt,
      };
      const list = this.duplicateSales.get(signal.itemId) ?? [];
      list.push(duplicate);
      this.duplicateSales.set(signal.itemId, list);
      this.processedEvents.set(signal.eventId, 'suppressed_duplicate_sale');
      return { outcome: 'suppressed_duplicate_sale', sale: duplicate, endedListings: [], needsRefund: true };
    }

    const sale: Sale = {
      id: this.nextId('sale'),
      itemId: signal.itemId,
      marketplace: signal.marketplace,
      orderId: signal.orderId,
      amountCents: signal.amountCents,
      occurredAt: signal.occurredAt,
      receipt,
    };
    this.sales.set(signal.itemId, sale);
    this.processedEvents.set(signal.eventId, 'sale_recorded');

    item.status = 'sold';

    // A sale anywhere ends every other listing. No human in the loop.
    const endedListings: Listing[] = [];
    for (const listing of this.listings.values()) {
      if (listing.itemId !== signal.itemId) continue;
      if (listing.state === 'ended') continue;
      if (listing.marketplace === signal.marketplace) continue;
      listing.state = 'ended';
      listing.endedAt = this.now();
      listing.endReason = `sold_on_${signal.marketplace}`;
      endedListings.push(listing);
    }

    return { outcome: 'sale_recorded', sale, endedListings, needsRefund: false };
  }

  /** The Facebook "Mark sold" tap: the seller says it sold there. */
  markSold(itemId: string, eventId: string): SaleResult {
    const item = this.items.get(itemId);
    if (!item) throw new Error(`unknown item ${itemId}`);
    return this.recordSale({
      eventId,
      marketplace: 'facebook',
      orderId: `manual_${eventId}`,
      itemId,
      amountCents: item.priceCents,
      occurredAt: this.now(),
      receipt: { source: 'manual_mark_sold', itemId },
    });
  }

  getSale(itemId: string): Sale | undefined {
    return this.sales.get(itemId);
  }

  getDuplicateSales(itemId: string): Sale[] {
    return this.duplicateSales.get(itemId) ?? [];
  }

  isSold(itemId: string): boolean {
    return this.sales.has(itemId);
  }
}
