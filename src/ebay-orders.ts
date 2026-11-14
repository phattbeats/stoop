/**
 * Stoop — the eBay sale sync.
 *
 * Etsy tells Stoop about a sale with a signed webhook. eBay does not do that
 * for a seller's own account in a way Stoop can rely on without a Marketing
 * API subscription and a public callback URL, so Stoop polls instead.
 *
 * Polling is not the lesser option here, it is the *correct* one for this
 * shape of business: Emily sells a handful of prints, and a poll every few
 * minutes costs almost nothing and never depends on a push subscription
 * being configured correctly.
 *
 * The join key is the SKU, and that is the reason the SKU is derived from
 * Stoop's own item id rather than from the title. An eBay order names the
 * *inventory item*, not the offer, and the only thing the order carries back
 * to us is the seller SKU. So the mapping is:
 *
 *     eBay order line  →  sellerSKU  →  Stoop item
 *
 * and it is derived, not looked up in a table that can drift.
 *
 * The shape of the eBay order payload is parsed defensively on purpose: the
 * fields that matter are read individually and a malformed line is skipped
 * rather than throwing away the whole order. An order with three lines where
 * one is odd should still record the two good ones.
 *
 * Endpoint shape:
 *   GET /sell/fulfillment/v1/order?orderStatuses=OPEN
 */

import type { Listing, Marketplace, SaleResult, SaleSignal } from './ledger.ts';
import { EBayAdapter } from './ebay.ts';
import { EBayClient } from './ebay-client.ts';
import type { DelistRunner, DelistTarget } from './sync.ts';

/** One line of an eBay order. */
export interface EBayOrderLine {
  lineItemId: string;
  /** eBay's inventory item id — not something Stoop stores. */
  itemId?: string;
  /** The seller SKU, which is how Stoop finds its own item. */
  sku?: string;
  title?: string;
  quantity: number;
  amountCents: number;
  currency: string;
}

export interface EBayOrder {
  orderId: string;
  createdAt?: string;
  status?: string;
  lines: EBayOrderLine[];
}

/** The little bit of the ledger the sale sync needs. */
export interface EBaySaleLedger {
  listItems(sellerId?: string): { id: string; priceCents: number }[];
  findListingByRemoteId(
    marketplace: Marketplace,
    remoteId: string,
  ): Promise<Listing | undefined> | Listing | undefined;
  recordSale(signal: SaleSignal): Promise<SaleResult> | SaleResult;
}

export interface EBayOrderSyncOptions {
  client: EBayClient;
  ledger: EBaySaleLedger;
  delist: DelistRunner;
  /** The seller's token. The sync asks for it fresh each time. */
  tokens: { accessToken(): Promise<string> };
}

export interface EBaySyncResult {
  ordersSeen: number;
  salesRecorded: number;
  duplicates: number;
  unmatchedLines: number;
  endedListings: number;
  needsHuman: number;
}

/**
 * Parse the Fulfillment API's order list.
 *
 * Every field is read defensively. eBay's payload has more shape than Stoop
 * needs, and the shape of a single line is not guaranteed.
 */
export function parseEbayOrders(payload: unknown): EBayOrder[] {
  if (!payload || typeof payload !== 'object') return [];
  const raw = (payload as { orders?: unknown }).orders;
  if (!Array.isArray(raw)) return [];

  const orders: EBayOrder[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const orderRecord = entry as Record<string, unknown>;
    const orderId = String(orderRecord.orderId ?? '').trim();
    if (!orderId) continue;

    const rawLines = Array.isArray(orderRecord.lineItems) ? orderRecord.lineItems : [];
    const lines: EBayOrderLine[] = [];
    for (const rawLine of rawLines) {
      if (!rawLine || typeof rawLine !== 'object') continue;
      const line = rawLine as Record<string, unknown>;
      const sku = String(line.sku ?? '').trim();
      const lineItemId = String(line.lineItemId ?? '').trim();
      const quantity = Number(line.quantity ?? 1) || 1;

      // The price can arrive as a number or as a {value, currency} pair
      // depending on the line's shape.
      const cost = line.lineItemCost ?? line.soldPrice ?? line.price;
      let amountCents = 0;
      let currency = 'USD';
      if (cost && typeof cost === 'object') {
        const costObj = cost as { value?: unknown; currency?: unknown };
        amountCents = Math.round(Number(costObj.value ?? 0) * 100);
        currency = String(costObj.currency ?? 'USD');
      } else if (typeof cost === 'number') {
        amountCents = Math.round(cost * 100);
      }

      const lineItem: EBayOrderLine = {
        lineItemId: lineItemId || `${orderId}-${lines.length}`,
        quantity,
        amountCents,
        currency,
      };
      if (sku) lineItem.sku = sku;
      if (line.itemId) lineItem.itemId = String(line.itemId);
      const title = String(line.title ?? '').trim();
      if (title) lineItem.title = title;
      lines.push(lineItem);
    }

    const order: EBayOrder = { orderId, lines };
    if (orderRecord.createdAt) order.createdAt = String(orderRecord.createdAt);
    if (orderRecord.orderStatus) order.status = String(orderRecord.orderStatus);
    orders.push(order);
  }
  return orders;
}

export class EBayOrderSync {
  private readonly options: EBayOrderSyncOptions;

  constructor(options: EBayOrderSyncOptions) {
    this.options = options;
  }

  /**
   * Ask eBay for the seller's open orders and record the sales.
   *
   * The order is the authority here, exactly as a receipt is for Etsy: the
   * line item is what says the thing sold, and Stoop does not move a listing
   * because a poll saw something odd.
   */
  /**
   * Poll eBay and record the sales.
   *
   * `sellerId` is per call, not per instance: the seller comes from the
   * session, and the poll loop runs without one. With no seller id the
   * whole ledger is scanned, which is right for a one-seller app and is
   * still safe, because a SKU only matches an item that was published.
   */
  async sync(sellerId?: string): Promise<EBaySyncResult> {
    const result: EBaySyncResult = {
      ordersSeen: 0,
      salesRecorded: 0,
      duplicates: 0,
      unmatchedLines: 0,
      endedListings: 0,
      needsHuman: 0,
    };

    const accessToken = await this.options.tokens.accessToken();
    const payload = await this.options.client.request(
      '/sell/fulfillment/v1/order?orderStatuses=OPEN',
      { method: 'GET', token: accessToken },
    );
    const orders = parseEbayOrders(payload);
    result.ordersSeen = orders.length;

    // The SKU map is built from Stoop's own items, so it cannot drift.
    const items = this.options.ledger.listItems(sellerId);
    const bySku = new Map<string, { id: string; priceCents: number }>();
    for (const item of items) {
      bySku.set(EBayAdapter.skuFor(item.id), item);
    }

    for (const order of orders) {
      for (const line of order.lines) {
        const item = line.sku ? bySku.get(line.sku) : undefined;
        if (!item) {
          // A line for something Stoop does not know: an item published by
          // hand, or an old offer. It is not an error, but it is not ours.
          result.unmatchedLines += 1;
          continue;
        }

        // The event id is the idempotency key. eBay's order line is stable,
        // so a re-poll records the sale once and then does nothing.
        const signal: SaleSignal = {
          eventId: `ebay_${order.orderId}_${line.lineItemId}`,
          marketplace: 'ebay',
          orderId: `ebay_${order.orderId}`,
          itemId: item.id,
          amountCents: line.amountCents || item.priceCents,
          occurredAt: order.createdAt ?? new Date().toISOString(),
          receipt: {
            orderId: order.orderId,
            lineItemId: line.lineItemId,
            sku: line.sku,
            quantity: line.quantity,
            currency: line.currency,
            title: line.title,
          },
        };

        const sale = await this.options.ledger.recordSale(signal);
        if (sale.outcome === 'ignored_duplicate_webhook') {
          result.duplicates += 1;
          continue;
        }
        if (sale.outcome === 'suppressed_duplicate_sale') {
          result.duplicates += 1;
          result.needsHuman += 1;
          continue;
        }

        result.salesRecorded += 1;
        result.endedListings += sale.endedListings.length;

        // A sale ends the other channels' listings. The remote ending is a
        // best-effort call, so it is queued rather than promised.
        const delist = await this.options.delist.delist(
          sale.endedListings.map((listing) => ({
            listingId: listing.id,
            itemId: listing.itemId,
            marketplace: listing.marketplace,
            remoteId: listing.remoteId,
          })),
        );
        result.needsHuman += delist.needsHuman;
      }
    }

    return result;
  }
}

/** The delist targets for a set of ended listings. */
export function delistTargets(listings: Listing[]): DelistTarget[] {
  return listings.map((listing) => ({
    listingId: listing.id,
    itemId: listing.itemId,
    marketplace: listing.marketplace,
    remoteId: listing.remoteId,
  }));
}
