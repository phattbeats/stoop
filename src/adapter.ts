/**
 * Stoop — the marketplace adapter seam.
 *
 * The item record never learns what an Etsy listing is. Each marketplace is
 * an adapter that knows its own shape, its own auth model and its own terms;
 * the ledger only ever sees a remote id and a state.
 *
 * Why a seam and not a `if (marketplace === 'etsy')` branch in the HTTP
 * layer: the differences between eBay and Etsy are not field-level, they are
 * policy-level (original/vintage only, no revision in Seller Hub, one-hour
 * tokens). A branch turns policy into conditionals; an adapter turns it into
 * a thing with a name.
 */

import type { Marketplace } from './ledger.ts';

/**
 * A photo to publish.
 *
 * Bytes, not a path: the adapter does not know the disk. But also a URL,
 * because the two marketplaces want different things — Etsy uploads the
 * bytes, and eBay downloads the picture from a URL itself. The URL is
 * optional: a marketplace that needs it refuses the listing when it is
 * missing.
 */
export interface PublishImage {
  data: Buffer;
  contentType: string;
  /** Where this same photo is reachable from the public internet. */
  url?: string;
}

/**
 * How the item is attributed on a marketplace.
 *
 * Etsy needs this explicitly (`who_made` + `when_made`) and it is a fact about
 * the item, not a default: "Emily made it" and "it is from the 1950s" are
 * different claims and Etsy buckets listings under both.
 */
export interface Attribution {
  whoMade: 'i_did' | 'someone_else' | 'collective';
  /** Etsy's era enum, e.g. '2020_2023', '1950s', 'before_1700'. */
  whenMade: string;
}

export interface PublishRequest {
  itemId: string;
  title: string;
  description: string;
  priceCents: number;
  tags: string[];
  /**
   * The three-valued truth from the item record: true (original or vintage),
   * false (not), null (nobody has said). Etsy is original/vintage only, and
   * that is enforced here, at write time — not in the UI.
   */
  originalOrVintage: boolean | null;
  attribution: Attribution;
  taxonomyId: number;
  shippingProfileId?: number;
  quantity?: number;
  images: PublishImage[];
}

export interface PublishResult {
  /** The marketplace's own id for the listing (Etsy listing id). */
  remoteId: string;
  /** The marketplace's state, when it reports one ('active', 'draft', ...). */
  state?: string;
}

export interface EndResult {
  ended: boolean;
  /** The listing was already gone — ending twice is not a failure. */
  alreadyGone?: boolean;
}

export interface MarketplaceAdapter {
  readonly marketplace: Marketplace;
  /** Create or revise the listing. Returns the remote id to store. */
  publish(request: PublishRequest): Promise<PublishResult>;
  /**
   * End a listing because the item sold elsewhere.
   *
   * This is a remote call and it can fail. Callers must not pretend it is
   * atomic: the local sale is the truth, the remote ending is a best-effort
   * action that a human finishes if it fails.
   */
  end(remoteId: string): Promise<EndResult>;
}
