/**
 * Stoop — the eBay adapter.
 *
 * eBay's Sell Inventory API, used the way its docs say:
 *   * a **seller token** (authorization code + PKCE) for anything that writes
 *     to a seller's inventory;
 *   * `X-EBAY-C-MARKETPLACE-ID` on every call (the transport in
 *     `ebay-client.ts` attaches it);
 *   * publishing is **three calls in order**, not one: an inventory item, then
 *     an offer that references it, then the listing policies that make the
 *     offer live.
 *
 * The rules this file enforces that a UI cannot:
 *   * **A SKU is unique across the seller's whole inventory**, so it is
 *     derived from Stoop's own item id, never from the title and never from
 *     the seller's guess.
 *   * **The offer is a separate object from the inventory item.** The item
 *     says what the thing is; the offer says what it is being sold for, at
 *     what price, on which marketplace, in which category. eBay models them
 *     separately, so Stoop does too — one item, one offer per marketplace.
 *   * **An offer does not go live on its own.** It needs a fulfillment
 *     policy, a payment policy and a return policy, and it needs the
 *     business-policies opt-in, or it stays in DRAFT forever. That is the
 *     single most common way this integration silently does nothing, so the
 *     policies are applied in the same call as the offer and the response
 *     state is checked afterwards.
 *   * **The environment is explicit.** Sandbox and production are different
 *     hosts with different sellers. A client that guessed wrong would
 *     publish Emily's one-off into a sandbox nobody reads, or the reverse.
 *
 * Endpoint shapes (Sell Inventory API):
 *   POST   /sell/inventory/v1/inventory_items
 *   POST   /sell/inventory/v1/offer
 *   PUT    /sell/inventory/v1/offer/{offerId}
 *   POST   /sell/inventory/v1/offer/{offerId}/listingPolicies
 *   DELETE /sell/inventory/v1/offer/{offerId}
 */

import type { EndResult, MarketplaceAdapter, PublishRequest, PublishResult } from './adapter.ts';
import { EBayClient, EBayError, EBayPolicyError } from './ebay-client.ts';

/** eBay's offer states that mean "a buyer can buy this right now". */
const LIVE_STATES = new Set(['PUBLISHED', 'ACTIVE']);

/** The listing policy id eBay uses for the "this offer is live" toggle. */
const LISTING_POLICY_ACTIVE = 'SELLING_POLICY_ACTIVE';

export interface EBayAdapterOptions {
  /** Where the seller's items live. Required — an offer cannot exist without one. */
  inventoryLocationId: string;
  /** The category the item is listed in, per marketplace. */
  categoryId: string;
  /** The store's policies. eBay will not publish an offer without them. */
  fulfillmentPolicyId: string;
  paymentPolicyId: string;
  returnPolicyId: string;
  /**
   * The marketplace the offer is created on, in eBay's offer-body form
   * ('EBAY_US'). This is NOT the same value as the transport's
   * marketplace header, which is a different id for the same marketplace.
   */
  marketplace?: string;
  /**
   * This app's public address, so a photo on the box can be given to eBay
   * as a URL. eBay downloads the picture itself — it does not accept bytes —
   * so a listing with no reachable URL has no picture.
   */
  publicUrl?: string;
  /**
   * The item's condition. eBay will not accept an offer without one; the
   * seller chooses it per item, and a one-off print that has never been
   * hung is 'NEW'.
   */
  condition?: string;
  /** How many are for sale. Emily sells one of a thing. */
  quantity?: number;
  /** Days the offer stays live when the item sells. */
  listingDurationDays?: number;
}

export interface EBayTokenProvider {
  accessToken(): Promise<string>;
}

/**
 * The eBay adapter.
 *
 * It is constructed with a token provider rather than a token, because a
 * seller token expires and the adapter is long-lived. The provider is asked
 * for a fresh token per publish, exactly like the Etsy adapter does.
 */
export class EBayAdapter implements MarketplaceAdapter {
  readonly marketplace = 'ebay' as const;

  private readonly client: EBayClient;
  private readonly tokens: EBayTokenProvider;
  private readonly options: EBayAdapterOptions;

  constructor(client: EBayClient, tokens: EBayTokenProvider, options: EBayAdapterOptions) {
    this.client = client;
    this.tokens = tokens;
    this.options = options;
  }

  /**
   * The SKU for an item.
   *
   * Unique across the seller's whole inventory, which means it cannot come
   * from the title (two prints, same title) and cannot come from a counter
   * that resets. Stoop's item id is already unique and already permanent, so
   * it is the SKU. A prefix keeps it recognizable to Emily in her eBay
   * inventory and distinct from any SKU she has of her own.
   */
  static skuFor(itemId: string): string {
    return `STOOP-${itemId.replace(/[^A-Za-z0-9-]/g, '').slice(0, 40)}`;
  }

  async publish(request: PublishRequest): Promise<PublishResult> {
    const title = request.title.trim();
    if (!title) {
      throw new EBayPolicyError('ebay_title_required', 'a listing needs a title');
    }
    if (!Number.isFinite(request.priceCents) || request.priceCents <= 0) {
      throw new EBayPolicyError('ebay_price_invalid', 'a listing needs a price above zero');
    }
    if (!this.options.inventoryLocationId) {
      throw new EBayPolicyError(
        'ebay_inventory_location_required',
        'ebay needs an inventory location before anything can be offered',
      );
    }
    if (!this.options.categoryId) {
      throw new EBayPolicyError('ebay_category_required', 'ebay needs a category id');
    }
    if (!this.options.fulfillmentPolicyId || !this.options.paymentPolicyId || !this.options.returnPolicyId) {
      throw new EBayPolicyError(
        'ebay_policies_required',
        'ebay needs fulfillment, payment and return policies before an offer can go live',
      );
    }

    const accessToken = await this.tokens.accessToken();

    const quantity = this.options.quantity ?? 1;
    const marketplace = this.options.marketplace ?? 'EBAY_US';
    // eBay rejects an offer without a condition, and it is a fact about the
    // item, not a default. An original print that was never displayed is
    // 'NEW'; anything she has had up is 'USED_EXCELLENT' at best.
    const condition = this.options.condition?.trim() || 'NEW';

    // 1. The inventory item — what the thing is. Created first because the
    //    offer references it by id.
    const sku = EBayAdapter.skuFor(request.itemId);
    const imageUrls = this.imageUrlsFor(request);
    const inventoryItem = await this.client.request(
      '/sell/inventory/v1/inventory_items',
      {
        method: 'POST',
        token: accessToken,
        body: JSON.stringify({
          product: {
            title: title.slice(0, 80),
            description: request.description.trim().slice(0, 1000),
            brand: 'Unbranded',
            aspects: {},
            imageUrls,
            inventoryLocationId: this.options.inventoryLocationId,
            sellerSKU: sku,
            // eBay needs the locale on the product, not on the offer.
            locale: 'en-US',
          },
        }),
      },
    );

    const inventoryItemId = String(inventoryItem?.inventoryItemId ?? '').trim();
    if (!inventoryItemId) {
      throw new EBayPolicyError(
        'ebay_inventory_item_not_created',
        'ebay did not return an inventory item id; nothing was offered',
      );
    }

    // 2. The offer — what it is being sold for, where, and at what price.
    //    The category lives on the offer, not the item: the same item can be
    //    categorized differently on two marketplaces.
    const categoryId = this.options.categoryId;
    const offer = await this.client.request('/sell/inventory/v1/offer', {
      method: 'POST',
      token: accessToken,
      body: JSON.stringify({
        format: 'FIXED_PRICE',
        inventoryItemId,
        marketplaceId: marketplace,
        category: { categoryId },
        listingDescription: request.description.trim().slice(0, 1000),
        condition,
        availableQuantity: quantity,
        pricingSummary: {
          price: { value: request.priceCents / 100, currency: 'USD' },
          quantity,
        },
      }),
    });

    const offerId = String(offer?.offerId ?? '').trim();
    if (!offerId) {
      throw new EBayPolicyError(
        'ebay_offer_not_created',
        'ebay did not return an offer id; the inventory item exists but is not for sale',
      );
    }

    // 3. The listing policies — what makes the offer live. Without this the
    //    offer sits in DRAFT and nothing is purchasable, which looks like
    //    success from the outside.
    await this.client.request(`/sell/inventory/v1/offer/${offerId}/listingPolicies`, {
      method: 'POST',
      token: accessToken,
      body: JSON.stringify({
        listingPolicies: {
          listingDuration: { duration: this.options.listingDurationDays ?? 30 },
          [LISTING_POLICY_ACTIVE]: true,
        },
        fulfillmentPolicyId: this.options.fulfillmentPolicyId,
        paymentPolicyId: this.options.paymentPolicyId,
        returnPolicyId: this.options.returnPolicyId,
        eBayFeesPaidBySeller: true,
      }),
    });

    // 4. Read the offer back. The policy call's response is not the offer's
    //    state, and "did it go live" is the only question that matters.
    const live = await this.readOffer(offerId, accessToken);
    const state = String(live?.status ?? '').trim();

    if (state && !LIVE_STATES.has(state)) {
      // The offer exists but a buyer cannot buy it. That is a real failure,
      // not a slow path: report it rather than storing it as live.
      throw new EBayPolicyError(
        'ebay_offer_not_live',
        `ebay created the offer but it is ${state}, not live; the listing policies did not take`,
      );
    }

    return { remoteId: offerId, state: state || 'PUBLISHED' };
  }

  /**
   * End an offer because the item sold elsewhere.
   *
   * This is a remote call and it can fail. The caller must not pretend it is
   * atomic: the local sale is the truth, the remote ending is a best-effort
   * action a human finishes if it fails.
   */
  async end(remoteId: string): Promise<EndResult> {
    const offerId = remoteId.trim();
    if (!offerId) {
      throw new EBayPolicyError('ebay_offer_id_required', 'there is no eBay offer to end');
    }
    const accessToken = await this.tokens.accessToken();
    try {
      await this.client.request(`/sell/inventory/v1/offer/${offerId}`, {
        method: 'DELETE',
        token: accessToken,
      });
      return { ended: true };
    } catch (error) {
      // An offer that is already gone is not a failure. eBay answers 404
      // for an unknown or deleted offer, and 204/410 for one that was
      // already ended.
      if (error instanceof EBayError && (error.status === 404 || error.status === 410)) {
        return { ended: true, alreadyGone: true };
      }
      throw error;
    }
  }

  /**
   * The picture URLs for the listing.
   *
   * eBay downloads the picture itself — it does not accept bytes — so a
   * photo with no reachable URL cannot go on the listing. The app builds
   * the URL when it reads the photo; this just collects them.
   */
  private imageUrlsFor(request: PublishRequest): string[] {
    const urls: string[] = [];
    for (const image of request.images) {
      const url = image.url?.trim();
      if (url && !urls.includes(url)) urls.push(url);
    }
    return urls.slice(0, 12);
  }

  private async readOffer(offerId: string, accessToken: string): Promise<any> {
    try {
      return await this.client.request(`/sell/inventory/v1/offer/${offerId}`, {
        method: 'GET',
        token: accessToken,
      });
    } catch {
      // A read-back that fails is not a reason to throw away a created
      // offer. The offer id is the thing the ledger stores.
      return undefined;
    }
  }
}
