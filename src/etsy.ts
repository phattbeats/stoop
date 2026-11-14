/**
 * Stoop — the Etsy adapter.
 *
 * Etsy's Open API v3, used the way its docs say:
 *   * an API key on every request (`x-api-key`);
 *   * OAuth 2.0 authorization code + PKCE for anything that writes (creating a
 *     listing needs `listings_w`); access tokens live one hour, refresh tokens
 *     have a ~90 day functional lifetime, so a refresh that fails means
 *     "re-consent", not "retry harder";
 *   * quota is enforced per API key with a sliding window, so a 429 comes
 *     with `retry-after` and is not a failure of the request.
 *
 * The rules this file enforces that a UI cannot:
 *   * Etsy is original/vintage only, enforced per item at write time.
 *   * A listing is created as a draft, gets its images, and only then goes
 *     active — Etsy refuses to publish a draft without an image.
 *
 * Endpoint shapes verified against the Open API v3 reference:
 *   POST   /v3/application/shops/{shop_id}/listings
 *   PATCH  /v3/application/shops/{shop_id}/listings/{listing_id}
 *   DELETE /v3/application/listings/{listing_id}
 *   POST   /v3/application/shops/{shop_id}/listings/{listing_id}/images
 *   GET    /v3/application/shops/{shop_id}/receipts/{receipt_id}
 *   POST   https://api.etsy.com/v3/public/oauth/token
 *   GET    https://www.etsy.com/oauth/connect
 */

import type { EndResult, MarketplaceAdapter, PublishRequest, PublishResult } from './adapter.ts';

export const ETSY_API_BASE = 'https://openapi.etsy.com';
export const ETSY_TOKEN_URL = 'https://api.etsy.com/v3/public/oauth/token';
export const ETSY_AUTHORIZE_URL = 'https://www.etsy.com/oauth/connect';

/** Hosts a receipt URL may point at. A webhook payload must not become a fetch to anywhere. */
const ALLOWED_HOSTS = ['openapi.etsy.com', 'api.etsy.com'];

export class EtsyError extends Error {
  readonly status: number;
  readonly body: string;
  readonly retryable: boolean;

  constructor(message: string, status: number, body = '', retryable = false) {
    super(message);
    this.name = 'EtsyError';
    this.status = status;
    this.body = body;
    this.retryable = retryable;
  }
}

/** The item does not satisfy Etsy's rules. A human (or Emily) has to fix it. */
export class EtsyPolicyError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'EtsyPolicyError';
    this.code = code;
  }
}

export interface EtsyTokens {
  accessToken: string;
  refreshToken: string;
  /** Seconds until the access token expires. */
  expiresIn: number;
  scope?: string;
}

export interface EtsyClientOptions {
  /** The app's API key. Also the OAuth client_id. */
  apiKey: string;
  /** OAuth client secret, when the app has one. */
  clientSecret?: string;
  baseUrl?: string;
  tokenUrl?: string;
  authorizeUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  /** How many times a 429 is retried before it is given up on. */
  maxRetries?: number;
}

export interface EtsyListingFields {
  quantity: number;
  title: string;
  description: string;
  price: number;
  whoMade: string;
  whenMade: string;
  taxonomyId: number;
  shippingProfileId?: number;
  returnPolicyId?: number;
  materials?: string[];
  tags?: string[];
  isSupply?: boolean;
  shouldAutoRenew?: boolean;
  isTaxable?: boolean;
  type?: 'physical' | 'download' | 'both';
}

export interface EtsyQuotaSnapshot {
  status: number;
  /**
   * Whatever Etsy sent back about the quota. The header names are not
   * documented, so they are captured as-is rather than guessed at.
   */
  headers: Record<string, string>;
}

export interface EtsyReceiptSummary {
  receiptId: string;
  listingId: string;
  amountCents: number;
  currency?: string;
  occurredAt: string;
  isPaid: boolean;
}

/**
 * A valid access token for the shop.
 *
 * The adapter never stores a token; it asks. Refresh happens here because the
 * one-hour access token is not a thing worth remembering.
 */
export interface EtsyTokenProvider {
  accessToken(): Promise<string>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class EtsyClient {
  private readonly options: EtsyClientOptions;

  constructor(options: EtsyClientOptions) {
    this.options = options;
  }

  private get baseUrl(): string {
    return (this.options.baseUrl ?? ETSY_API_BASE).replace(/\/$/, '');
  }

  private get fetchImpl(): typeof fetch {
    return this.options.fetchImpl ?? fetch;
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  private async sleep(ms: number): Promise<void> {
    const sleep = this.options.sleep ?? defaultSleep;
    await sleep(ms);
  }

  /** The URL Emily is sent to so *she* consents. Agents never consent for her. */
  authorizationUrl(params: {
    redirectUri: string;
    scope: string;
    state: string;
    codeChallenge: string;
  }): string {
    const url = new URL(this.options.authorizeUrl ?? ETSY_AUTHORIZE_URL);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.options.apiKey);
    url.searchParams.set('redirect_uri', params.redirectUri);
    url.searchParams.set('scope', params.scope);
    url.searchParams.set('state', params.state);
    url.searchParams.set('code_challenge', params.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return url.toString();
  }

  /** Exchange the authorization code for tokens. */
  async exchangeCode(params: { code: string; codeVerifier: string; redirectUri: string }): Promise<EtsyTokens> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: this.options.apiKey,
      code: params.code,
      code_verifier: params.codeVerifier,
      redirect_uri: params.redirectUri,
    });
    if (this.options.clientSecret) body.set('client_secret', this.options.clientSecret);
    return this.requestTokens(body);
  }

  /** A refresh token has a ~90 day functional lifetime. When it stops working, Emily re-consents. */
  async refresh(refreshToken: string): Promise<EtsyTokens> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: this.options.apiKey,
      refresh_token: refreshToken,
    });
    if (this.options.clientSecret) body.set('client_secret', this.options.clientSecret);
    return this.requestTokens(body);
  }

  private async requestTokens(body: URLSearchParams): Promise<EtsyTokens> {
    const response = await this.fetchImpl(this.options.tokenUrl ?? ETSY_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new EtsyError(`etsy refused the token request (${response.status})`, response.status, text.slice(0, 400));
    }
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new EtsyError('etsy returned a non-JSON token response', response.status, text.slice(0, 400));
    }
    const accessToken = String(payload.access_token ?? '');
    const refreshToken = String(payload.refresh_token ?? '');
    if (!accessToken) {
      throw new EtsyError('etsy returned no access token', response.status, text.slice(0, 400));
    }
    const tokens: EtsyTokens = {
      accessToken,
      refreshToken,
      expiresIn: Number(payload.expires_in ?? 3600),
    };
    if (typeof payload.scope === 'string') tokens.scope = payload.scope;
    return tokens;
  }

  /**
   * The shop id for a token.
   *
   * The numeric prefix of an Etsy access token is the user id, and the shops
   * that user owns are one call away.
   */
  async findShopId(accessToken: string): Promise<string | undefined> {
    const userId = accessToken.split('.')[0];
    if (!/^\d+$/.test(userId)) return undefined;
    const payload = await this.request(`/v3/application/users/${userId}/shops`, accessToken);
    const shops = Array.isArray(payload?.results) ? payload.results : [];
    const first = shops[0] as { shop_id?: number | string } | undefined;
    return first?.shop_id === undefined ? undefined : String(first.shop_id);
  }

  /** Create a draft listing. It is not live until it has an image and goes active. */
  async createListing(
    shopId: string,
    accessToken: string,
    fields: EtsyListingFields,
  ): Promise<{ listingId: string; state?: string }> {
    const form = new URLSearchParams();
    form.set('quantity', String(fields.quantity));
    form.set('title', fields.title);
    form.set('description', fields.description);
    form.set('price', String(fields.price));
    form.set('who_made', fields.whoMade);
    form.set('when_made', fields.whenMade);
    form.set('taxonomy_id', String(fields.taxonomyId));
    if (fields.shippingProfileId !== undefined) form.set('shipping_profile_id', String(fields.shippingProfileId));
    if (fields.returnPolicyId !== undefined) form.set('return_policy_id', String(fields.returnPolicyId));
    if (fields.materials?.length) form.set('materials', fields.materials.join(','));
    if (fields.tags?.length) form.set('tags', fields.tags.join(','));
    if (fields.isSupply !== undefined) form.set('is_supply', String(fields.isSupply));
    if (fields.shouldAutoRenew !== undefined) form.set('should_auto_renew', String(fields.shouldAutoRenew));
    if (fields.isTaxable !== undefined) form.set('is_taxable', String(fields.isTaxable));
    if (fields.type) form.set('type', fields.type);

    const payload = await this.request(
      `/v3/application/shops/${encodeURIComponent(shopId)}/listings`,
      accessToken,
      { method: 'POST', body: form.toString() },
    );
    const listingId = String(payload?.listing_id ?? '');
    if (!listingId) {
      throw new EtsyError('etsy created no listing id', 200, JSON.stringify(payload).slice(0, 400));
    }
    const result: { listingId: string; state?: string } = { listingId };
    if (typeof payload?.state === 'string') result.state = payload.state;
    return result;
  }

  /** Upload one image. Etsy will not publish a listing that has none. */
  async uploadImage(
    shopId: string,
    listingId: string,
    accessToken: string,
    image: { data: Buffer; contentType: string },
  ): Promise<string | undefined> {
    const payload = await this.request(
      `/v3/application/shops/${encodeURIComponent(shopId)}/listings/${encodeURIComponent(listingId)}/images`,
      accessToken,
      { method: 'POST', body: image.data, contentType: image.contentType },
    );
    const imageId = payload?.listing_image_id;
    return imageId === undefined ? undefined : String(imageId);
  }

  /** Put the listing live. */
  async activateListing(
    shopId: string,
    listingId: string,
    accessToken: string,
    shippingProfileId?: number,
  ): Promise<void> {
    const form = new URLSearchParams({ state: 'active' });
    if (shippingProfileId !== undefined) form.set('shipping_profile_id', String(shippingProfileId));
    await this.request(
      `/v3/application/shops/${encodeURIComponent(shopId)}/listings/${encodeURIComponent(listingId)}`,
      accessToken,
      { method: 'PATCH', body: form.toString() },
    );
  }

  /**
   * Delete a listing.
   *
   * Deleting is how a one-of-a-kind listing stops existing on Etsy. 404 means
   * it is already gone, which is the outcome we wanted.
   */
  async deleteListing(listingId: string, accessToken: string): Promise<EndResult> {
    try {
      await this.request(`/v3/application/listings/${encodeURIComponent(listingId)}`, accessToken, {
        method: 'DELETE',
      });
      return { ended: true };
    } catch (error) {
      if (error instanceof EtsyError && error.status === 404) return { ended: true, alreadyGone: true };
      throw error;
    }
  }

  /**
   * Fetch the receipt an order event points at.
   *
   * The URL comes from the webhook payload, so it is checked before it is
   * fetched: only Etsy's own hosts, only https.
   */
  async fetchReceipt(url: string, accessToken: string): Promise<Record<string, unknown>> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new EtsyPolicyError('bad_resource_url', `the order event carried an unusable resource_url: ${url}`);
    }
    if (parsed.protocol !== 'https:' || !ALLOWED_HOSTS.includes(parsed.hostname)) {
      throw new EtsyPolicyError('bad_resource_url', `refusing to fetch a receipt from ${parsed.hostname}`);
    }
    const payload = await this.request(`${parsed.pathname}${parsed.search}`, accessToken);
    return (payload ?? {}) as Record<string, unknown>;
  }

  /** The last quota headers Etsy sent, for the health endpoint. */
  quota: EtsyQuotaSnapshot | undefined;

  private async request(
    path: string,
    accessToken: string,
    init: { method?: string; body?: string | Buffer; contentType?: string } = {},
  ): Promise<any> {
    const maxRetries = this.options.maxRetries ?? 2;
    let attempt = 0;

    for (;;) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 20_000);
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method: init.method ?? 'GET',
          headers: {
            'x-api-key': this.options.apiKey,
            authorization: `Bearer ${accessToken}`,
            accept: 'application/json',
            ...(init.body === undefined ? {} : { 'content-type': init.contentType ?? 'application/x-www-form-urlencoded' }),
          },
          ...(init.body === undefined ? {} : { body: init.body as BodyInit }),
          signal: controller.signal,
        });
      } catch (error) {
        clearTimeout(timeout);
        throw new EtsyError(
          `etsy could not be reached: ${String((error as Error).message ?? error)}`,
          0,
          '',
          true,
        );
      }
      clearTimeout(timeout);

      this.quota = readQuota(response);

      if (response.status === 429 && attempt < maxRetries) {
        attempt += 1;
        const retryAfter = Number(response.headers.get('retry-after') ?? '0');
        // Etsy's sliding window is per API key; waiting is the whole fix.
        await this.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000);
        continue;
      }

      const text = await response.text();
      if (!response.ok) {
        throw new EtsyError(
          `etsy returned ${response.status}`,
          response.status,
          text.slice(0, 600),
          response.status === 429 || response.status >= 500,
        );
      }
      if (!text) return {};
      try {
        return JSON.parse(text);
      } catch {
        throw new EtsyError('etsy returned a non-JSON response', response.status, text.slice(0, 400));
      }
    }
  }
}

function readQuota(response: Response): EtsyQuotaSnapshot {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    if (key.toLowerCase().startsWith('x-etsy-')) headers[key.toLowerCase()] = value;
  });
  return { status: response.status, headers };
}

/**
 * The sale inside a receipt.
 *
 * The receipt is the authority: which listing sold, for how much, and when.
 * We do not decrement stock because a webhook arrived.
 */
export function summarizeReceipt(receipt: Record<string, unknown>): EtsyReceiptSummary {
  const transactions = Array.isArray(receipt.transactions) ? receipt.transactions : [];
  const first = transactions[0] as
    | { listing_id?: number | string; paid_timestamp?: number; create_timestamp?: number }
    | undefined;
  const listingId = first?.listing_id === undefined ? '' : String(first.listing_id);
  if (!listingId) {
    throw new EtsyPolicyError('receipt_without_listing', 'the receipt names no listing');
  }
  const total = (receipt.grand_total ?? receipt.subtotal) as
    | { amount?: number; divisor?: number; currency_code?: string }
    | undefined;
  const amount = Number(total?.amount ?? 0);
  const divisor = Number(total?.divisor ?? 100) || 100;
  const amountCents = Math.round((amount / divisor) * 100);
  const stamp = Number(first?.paid_timestamp ?? first?.create_timestamp ?? receipt.create_timestamp ?? 0);
  const occurredAt = stamp > 0 ? new Date(stamp * 1000).toISOString() : new Date().toISOString();
  const summary: EtsyReceiptSummary = {
    receiptId: String(receipt.receipt_id ?? ''),
    listingId,
    amountCents,
    occurredAt,
    // A receipt that does not say is_paid is from an order.paid event, so it
    // is paid. A receipt that says false is not.
    isPaid: receipt.is_paid === undefined ? true : receipt.is_paid === true,
  };
  if (typeof total?.currency_code === 'string') summary.currency = total.currency_code;
  return summary;
}

export interface EtsyAdapterOptions {
  /** The shop we sell through. A function when the shop comes from the tokens. */
  shopId: string | (() => Promise<string>);
  defaultTaxonomyId?: number;
  defaultShippingProfileId?: number;
  /** The attribution used when the caller does not know the era. */
  defaultWhoMade?: 'i_did' | 'someone_else' | 'collective';
  defaultWhenMade?: string;
}

/**
 * The Etsy adapter.
 *
 * `publish` refuses anything that is not original or vintage — at write time,
 * per item, because that is where Etsy's rule actually bites.
 */
export class EtsyAdapter implements MarketplaceAdapter {
  readonly marketplace = 'etsy' as const;

  private readonly client: EtsyClient;
  private readonly options: EtsyAdapterOptions;
  private readonly tokens: EtsyTokenProvider;

  constructor(client: EtsyClient, tokens: EtsyTokenProvider, options: EtsyAdapterOptions) {
    this.client = client;
    this.tokens = tokens;
    this.options = options;
  }

  async publish(request: PublishRequest): Promise<PublishResult> {
    if (request.originalOrVintage !== true) {
      throw new EtsyPolicyError(
        'etsy_original_vintage_only',
        'etsy is original/vintage only; this item does not say it is either',
      );
    }
    const shopId = await this.resolveShopId();
    if (!request.title.trim()) {
      throw new EtsyPolicyError('etsy_title_required', 'a listing needs a title');
    }
    if (!Number.isFinite(request.priceCents) || request.priceCents <= 0) {
      throw new EtsyPolicyError('etsy_price_invalid', 'a listing needs a price above zero');
    }
    const taxonomyId = request.taxonomyId ?? this.options.defaultTaxonomyId;
    if (!taxonomyId) {
      throw new EtsyPolicyError('etsy_taxonomy_required', 'a listing needs a taxonomy id');
    }

    const accessToken = await this.tokens.accessToken();
    const created = await this.client.createListing(shopId, accessToken, {
      quantity: request.quantity ?? 1,
      title: request.title.trim().slice(0, 140),
      description: request.description.trim().slice(0, 4000),
      price: request.priceCents / 100,
      whoMade: request.attribution.whoMade,
      whenMade: request.attribution.whenMade,
      taxonomyId,
      ...(request.shippingProfileId ?? this.options.defaultShippingProfileId
        ? { shippingProfileId: request.shippingProfileId ?? this.options.defaultShippingProfileId }
        : {}),
      tags: request.tags.slice(0, 13),
      isSupply: false,
      shouldAutoRenew: false,
      isTaxable: true,
      type: 'physical',
    });

    for (const image of request.images.slice(0, 10)) {
      await this.client.uploadImage(shopId, created.listingId, accessToken, image);
    }

    await this.client.activateListing(
      shopId,
      created.listingId,
      accessToken,
      request.shippingProfileId ?? this.options.defaultShippingProfileId,
    );

    return { remoteId: created.listingId, state: 'active' };
  }

  private async resolveShopId(): Promise<string> {
    const shopId = typeof this.options.shopId === 'function' ? await this.options.shopId() : this.options.shopId;
    if (!shopId) throw new EtsyPolicyError('etsy_shop_unknown', 'the etsy shop is not known yet');
    return shopId;
  }

  async end(remoteId: string): Promise<EndResult> {
    const accessToken = await this.tokens.accessToken();
    return this.client.deleteListing(remoteId, accessToken);
  }
}
