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

  return config;
}
