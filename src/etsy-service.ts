/**
 * Stoop — the Etsy side of the app.
 *
 * One place that knows how Etsy works: the consent handshake, publishing a
 * listing, and turning a paid-order webhook into a sale in the ledger.
 *
 * The sold-sync is the part that matters, and its order of authority is the
 * whole design:
 *
 *   1. verify the signature over the raw bytes — before anything is parsed;
 *   2. reject a stale timestamp — a captured delivery must not replay;
 *   3. the webhook id is the idempotency key — Etsy retries;
 *   4. fetch the receipt the event points at — a webhook is a claim, the
 *      receipt is the proof;
 *   5. only then record the sale and queue the cross-channel delist.
 *
 * Stock never moves because a webhook arrived.
 */

import type { PublishImage, PublishResult } from './adapter.ts';
import type { Listing, Marketplace, SaleResult, SaleSignal } from './ledger.ts';
import { EtsyClient, EtsyPolicyError, summarizeReceipt, type EtsyTokens } from './etsy.ts';
import { EtsyTokenManager, type EtsyTokenStore } from './etsy-store.ts';
import {
  EtsyWebhookError,
  isOrderPaid,
  parseEtsyEvent,
  verifyEtsyWebhook,
  type EtsyWebhookHeaders,
} from './etsy-webhook.ts';
import type { DelistRunner, DelistTarget } from './sync.ts';

/** The little bit of the ledger the sold-sync needs. */
export interface EtsySaleLedger {
  findListingByRemoteId(
    marketplace: Marketplace,
    remoteId: string,
  ): Promise<Listing | undefined> | Listing | undefined;
  recordSale(signal: SaleSignal): Promise<SaleResult> | SaleResult;
}

export interface EtsyPublishInput {
  itemId: string;
  title: string;
  description: string;
  priceCents: number;
  tags: string[];
  originalOrVintage: boolean | null;
  images: PublishImage[];
  taxonomyId?: number;
  shippingProfileId?: number;
  whoMade?: 'i_did' | 'someone_else' | 'collective';
  whenMade?: string;
}

export interface EtsyServiceOptions {
  client: EtsyClient;
  adapter: { publish(request: any): Promise<PublishResult> };
  tokenStore: EtsyTokenStore;
  tokenManager: EtsyTokenManager;
  /** Signing secrets from the Etsy Webhook Portal. */
  webhookSecrets: string[];
  /** The shop we sell through, when it is known from configuration. */
  shopId?: string;
  taxonomyId?: number;
  shippingProfileId?: number;
  whoMade?: 'i_did' | 'someone_else' | 'collective';
  whenMade?: string;
  scope: string;
  redirectUri: string;
  now?: () => number;
}

export interface EtsyDeliveryResult {
  status:
    | 'ignored'
    | 'sale_recorded'
    | 'suppressed_duplicate_sale'
    | 'ignored_duplicate_webhook'
    | 'unknown_listing'
    | 'receipt_not_paid'
    | 'shop_not_connected';
  eventType?: string;
  eventId?: string;
  listingId?: string;
  endedListings?: number;
  needsHuman?: number;
}

export class EtsyDeliveryError extends Error {
  readonly reason: string;

  constructor(reason: string, message: string) {
    super(message);
    this.name = 'EtsyDeliveryError';
    this.reason = reason;
  }
}

export class EtsyService {
  private readonly options: EtsyServiceOptions;
  private readonly ledger: EtsySaleLedger;
  private readonly delist: DelistRunner;

  constructor(options: EtsyServiceOptions, ledger: EtsySaleLedger, delist: DelistRunner) {
    this.options = options;
    this.ledger = ledger;
    this.delist = delist;
  }

  /** The URL Emily is sent to. She consents; nobody consents for her. */
  authorizationUrl(state: string, codeChallenge: string): string {
    return this.options.client.authorizationUrl({
      redirectUri: this.options.redirectUri,
      scope: this.options.scope,
      state,
      codeChallenge,
    });
  }

  /** Exchange the code, keep the tokens, find the shop. */
  async completeAuthorization(sellerId: string, code: string, codeVerifier: string): Promise<{ shopId?: string }> {
    const tokens: EtsyTokens = await this.options.client.exchangeCode({
      code,
      codeVerifier,
      redirectUri: this.options.redirectUri,
    });
    let shopId = this.options.shopId;
    if (!shopId) {
      const found = await this.options.client.findShopId(tokens.accessToken);
      shopId = found;
    }
    await this.options.tokenStore.save(sellerId, { ...tokens, shopId });
    return shopId ? { shopId } : {};
  }

  /**
   * Is a seller connected to Etsy?
   *
   * The phone needs this: a publish button for an account that was never
   * connected is a button that always fails.
   */
  async isConnected(sellerId: string): Promise<boolean> {
    const stored = await this.options.tokenStore.get(sellerId);
    return Boolean(stored);
  }

  /** Publish an item on Etsy. */
  async publishListing(input: EtsyPublishInput): Promise<PublishResult> {
    const taxonomyId = input.taxonomyId ?? this.options.taxonomyId;
    if (!taxonomyId) {
      throw new EtsyPolicyError('etsy_taxonomy_required', 'a listing needs a taxonomy id');
    }
    return this.options.adapter.publish({
      itemId: input.itemId,
      title: input.title,
      description: input.description,
      priceCents: input.priceCents,
      tags: input.tags,
      originalOrVintage: input.originalOrVintage,
      attribution: {
        whoMade: input.whoMade ?? this.options.whoMade ?? 'i_did',
        whenMade: input.whenMade ?? this.options.whenMade ?? '2020_2023',
      },
      taxonomyId,
      shippingProfileId: input.shippingProfileId ?? this.options.shippingProfileId,
      images: input.images,
    });
  }

  /**
   * Verify a delivery.
   *
   * Any of the configured secrets may match, because Etsy gives one signing
   * secret per webhook endpoint and a shop can have more than one.
   */
  verify(raw: Buffer, headers: EtsyWebhookHeaders): { eventId: string; timestamp: number } {
    if (!this.options.webhookSecrets.length) {
      throw new EtsyDeliveryError('no_secret', 'no etsy webhook secret is configured');
    }
    let last: EtsyWebhookError | undefined;
    for (const secret of this.options.webhookSecrets) {
      try {
        return verifyEtsyWebhook(raw, headers, {
          secret,
          ...(this.options.now ? { now: this.options.now } : {}),
        });
      } catch (error) {
        if (error instanceof EtsyWebhookError) last = error;
        else throw error;
      }
    }
    throw new EtsyDeliveryError(last?.reason ?? 'bad_signature', last?.message ?? 'the delivery did not verify');
  }

  /**
   * Handle a delivery.
   *
   * Throws only when the delivery itself is bad (bad signature, stale
   * timestamp) or when the receipt could not be fetched — a transient
   * failure, and Etsy retries those. A sale we cannot place is not a
   * failure: it is queued for a human.
   */
  async handleDelivery(raw: Buffer, headers: EtsyWebhookHeaders): Promise<EtsyDeliveryResult> {
    const verified = this.verify(raw, headers);
    const event = parseEtsyEvent(raw, verified.eventId, verified.timestamp);

    if (!isOrderPaid(event)) {
      return { status: 'ignored', eventType: event.eventType, eventId: event.eventId };
    }

    const shopId = event.shopId ?? this.options.shopId ?? '';
    let accessToken: string;
    try {
      accessToken = await this.options.tokenManager.accessTokenForShop(shopId);
    } catch (error) {
      if (error instanceof EtsyPolicyError && error.code === 'etsy_shop_not_connected') {
        await this.delist.needsReview({
          marketplace: 'etsy',
          remoteId: event.eventId,
          reason: `a sale arrived for shop ${shopId}, which is not connected to stoop`,
          detail: { eventId: event.eventId, shopId },
        });
        return { status: 'shop_not_connected', eventType: event.eventType, eventId: event.eventId };
      }
      throw error;
    }

    if (!event.resourceUrl) {
      throw new EtsyDeliveryError('no_resource_url', 'the order event carried no resource_url');
    }

    // The receipt is the authority. A webhook is only a claim.
    const receipt = await this.options.client.fetchReceipt(event.resourceUrl, accessToken);
    const summary = summarizeReceipt(receipt);

    if (!summary.isPaid) {
      await this.delist.needsReview({
        marketplace: 'etsy',
        remoteId: summary.listingId,
        reason: 'an order event arrived for a receipt that is not paid',
        detail: { eventId: event.eventId, receiptId: summary.receiptId },
      });
      return { status: 'receipt_not_paid', eventType: event.eventType, eventId: event.eventId };
    }

    const listing = await this.ledger.findListingByRemoteId('etsy', summary.listingId);
    if (!listing) {
      await this.delist.needsReview({
        marketplace: 'etsy',
        remoteId: summary.listingId,
        reason: 'a sale arrived for a listing stoop does not know about',
        detail: { eventId: event.eventId, receiptId: summary.receiptId },
      });
      return { status: 'unknown_listing', eventType: event.eventType, eventId: event.eventId };
    }

    const result = await this.ledger.recordSale({
      eventId: event.eventId,
      marketplace: 'etsy',
      orderId: summary.receiptId ? `etsy_${summary.receiptId}` : `etsy_${event.eventId}`,
      itemId: listing.itemId,
      amountCents: summary.amountCents,
      occurredAt: summary.occurredAt,
      receipt,
    });

    const delistOutcome = await this.delist.delist(this.targetsOf(result.endedListings));

    return {
      status: result.outcome,
      eventType: event.eventType,
      eventId: event.eventId,
      listingId: summary.listingId,
      endedListings: result.endedListings.length,
      needsHuman: delistOutcome.needsHuman,
    };
  }

  private targetsOf(listings: Listing[]): DelistTarget[] {
    return listings.map((listing) => ({
      listingId: listing.id,
      itemId: listing.itemId,
      marketplace: listing.marketplace,
      remoteId: listing.remoteId,
    }));
  }
}
