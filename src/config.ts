/**
 * Stoop — runtime configuration.
 *
 * Everything the app needs comes from the environment. Secrets are never in
 * the repo; the deploy writes them into the service's env file on vps1.
 */

export interface Config {
  port: number;
  publicUrl: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scope: string;
  databaseUrl: string;
  /** The app keeps its own short session; this is how short. */
  sessionTtlMinutes: number;
  /** HMAC key for the short-lived login-state cookie. */
  sessionSecret: string;
  /** LiteLLM base URL for the Anthropic-path drafter. */
  llmBaseUrl: string;
  /** LiteLLM key for the drafter. Empty means the drafter is unavailable. */
  llmApiKey: string;
  /** Anthropic model id, e.g. anthropic/claude-sonnet-5. */
  llmModel: string;
  /** Where Emily's photos live on the box. */
  photosDir: string;
  /** Etsy, when the app has been given credentials for it. */
  etsy?: EtsyConfig;
  /** eBay, when the app has been given credentials for it. */
  ebay?: EbayConfig;
}

/**
 * eBay's credentials and the marketplace defaults.
 *
 * Optional for the same reason Etsy's block is: without a key the app still
 * serves everything else. The environment is explicit — sandbox and production
 * are different hosts with different sellers, and a client that guessed wrong
 * would publish into the wrong marketplace.
 */
export interface EbayConfig {
  /** The app's client id (eBay's App ID). */
  clientId: string;
  /** The app's client secret (eBay's Cert ID). */
  clientSecret: string;
  environment: 'sandbox' | 'production';
  /** The scope requested with a seller token. */
  scope: string;
  /** The marketplace id sent on every API call (the header form, e.g. '0'). */
  marketplaceId: string;
  /** The marketplace the offer body names (e.g. 'EBAY_US'). */
  offerMarketplace?: string;
  /** A seller's refresh token, when there is one. */
  refreshToken?: string;
  /** The sandbox or production seller this app publishes as. */
  sellerUserId?: string;
  /** Where eBay sends the seller back after consent. */
  redirectUri: string;
  /**
   * Where the seller's items live. eBay will not create an inventory item
   * without it, and it cannot be inferred — it is a per-account id.
   */
  inventoryLocationId?: string;
  /** The category items are listed in. */
  categoryId?: string;
  /** The store's three policies. An offer without them never goes live. */
  fulfillmentPolicyId?: string;
  paymentPolicyId?: string;
  returnPolicyId?: string;
}

/**
 * Etsy's credentials and the shop defaults.
 *
 * The Etsy adapter is optional: without a key the app still serves the Today
 * screen and the Facebook card, it just cannot publish to Etsy. That matters
 * because the Etsy account is Emily's and hers to connect, not ours to fake.
 */
export interface EtsyConfig {
  /** The app API key. Also the OAuth client_id. */
  apiKey: string;
  clientSecret: string;
  /** Signing secrets from the Etsy Webhook Portal. One per endpoint. */
  webhookSecrets: string[];
  /** The shop we sell through. */
  shopId: string;
  /** Default taxonomy id for a listing. */
  taxonomyId?: number;
  /** Default shipping profile for a physical listing. */
  shippingProfileId?: number;
  /** The scopes the consent screen asks for. */
  scope: string;
  redirectUri: string;
  /** Who made the item, when nobody says otherwise. */
  whoMade: 'i_did' | 'someone_else' | 'collective';
  /** The era, when nobody says otherwise. */
  whenMade: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env: ${name}`);
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const publicUrl = optional('STOOP_PUBLIC_URL', 'https://stoop.phatt.vip').replace(/\/$/, '');
  const issuer = optional('STOOP_ISSUER', 'https://auth.phatt.vip/application/o/stoop/');
  const scope = optional('STOOP_SCOPE', 'openid profile');
  const config: Config = {
    port: Number(optional('STOOP_PORT', '3000')),
    publicUrl,
    issuer,
    clientId: required('STOOP_CLIENT_ID'),
    clientSecret: required('STOOP_CLIENT_SECRET'),
    redirectUri: optional('STOOP_REDIRECT_URI', `${publicUrl}/auth/callback`),
    scope,
    databaseUrl: required('STOOP_DATABASE_URL'),
    sessionTtlMinutes: Number(optional('STOOP_SESSION_TTL_MINUTES', '480')),
    sessionSecret: required('STOOP_SESSION_SECRET'),
    llmBaseUrl: optional('STOOP_LLM_BASE_URL', 'http://10.0.0.100:4000').replace(/\/$/, ''),
    llmApiKey: optional('STOOP_LLM_API_KEY', ''),
    llmModel: optional('STOOP_LLM_MODEL', 'anthropic/claude-sonnet-5'),
    photosDir: optional('STOOP_PHOTOS_DIR', '/srv/appdata/stoop/photos'),
  };

  const etsyApiKey = optional('STOOP_ETSY_API_KEY', '');
  if (etsyApiKey) {
    const etsy: EtsyConfig = {
      apiKey: etsyApiKey,
      clientSecret: optional('STOOP_ETSY_CLIENT_SECRET', ''),
      webhookSecrets: optional('STOOP_ETSY_WEBHOOK_SECRETS', '')
        .split(',')
        .map((secret) => secret.trim())
        .filter(Boolean),
      shopId: optional('STOOP_ETSY_SHOP_ID', ''),
      scope: optional('STOOP_ETSY_SCOPE', 'listings_w listings_d transactions_r'),
      redirectUri: optional('STOOP_ETSY_REDIRECT_URI', `${publicUrl}/api/etsy/callback`),
      whoMade: (optional('STOOP_ETSY_WHO_MADE', 'i_did') as EtsyConfig['whoMade']),
      whenMade: optional('STOOP_ETSY_WHEN_MADE', '2020_2023'),
    };
    const taxonomyId = Number(optional('STOOP_ETSY_TAXONOMY_ID', ''));
    if (Number.isFinite(taxonomyId) && taxonomyId > 0) etsy.taxonomyId = taxonomyId;
    const shippingProfileId = Number(optional('STOOP_ETSY_SHIPPING_PROFILE_ID', ''));
    if (Number.isFinite(shippingProfileId) && shippingProfileId > 0) etsy.shippingProfileId = shippingProfileId;
    config.etsy = etsy;
  }

  const ebayClientId = optional('STOOP_EBAY_CLIENT_ID', '');
  if (ebayClientId) {
    const ebay: EbayConfig = {
      clientId: ebayClientId,
      clientSecret: optional('STOOP_EBAY_CLIENT_SECRET', ''),
      environment: optional('STOOP_EBAY_ENV', 'sandbox') === 'production' ? 'production' : 'sandbox',
      scope: optional('STOOP_EBAY_SCOPE', 'https://api.ebay.com/oauth/api_scope'),
      marketplaceId: optional('STOOP_EBAY_MARKETPLACE_ID', '0'),
      offerMarketplace: optional('STOOP_EBAY_OFFER_MARKETPLACE', 'EBAY_US'),
      redirectUri: optional('STOOP_EBAY_REDIRECT_URI', `${publicUrl}/api/ebay/callback`),
    };
    const refreshToken = optional('STOOP_EBAY_REFRESH_TOKEN', '');
    if (refreshToken) ebay.refreshToken = refreshToken;
    const sellerUserId = optional('STOOP_EBAY_SELLER_USER_ID', '');
    if (sellerUserId) ebay.sellerUserId = sellerUserId;
    const inventoryLocationId = optional('STOOP_EBAY_INVENTORY_LOCATION_ID', '');
    if (inventoryLocationId) ebay.inventoryLocationId = inventoryLocationId;
    const categoryId = optional('STOOP_EBAY_CATEGORY_ID', '');
    if (categoryId) ebay.categoryId = categoryId;
    const fulfillmentPolicyId = optional('STOOP_EBAY_FULFILLMENT_POLICY_ID', '');
    if (fulfillmentPolicyId) ebay.fulfillmentPolicyId = fulfillmentPolicyId;
    const paymentPolicyId = optional('STOOP_EBAY_PAYMENT_POLICY_ID', '');
    if (paymentPolicyId) ebay.paymentPolicyId = paymentPolicyId;
    const returnPolicyId = optional('STOOP_EBAY_RETURN_POLICY_ID', '');
    if (returnPolicyId) ebay.returnPolicyId = returnPolicyId;
    config.ebay = ebay;
  }

  return config;
}
