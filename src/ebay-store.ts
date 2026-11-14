/**
 * Stoop — the eBay token store and the token manager.
 *
 * Two implementations each: Postgres for the running app, memory for tests.
 * Same split as the ledger and the Etsy token store: a token that behaves
 * differently in tests than in production is not worth having.
 *
 * The refresh deadline is stored rather than computed at read time. eBay's
 * refresh token has a ~180 day *functional* lifetime rather than a documented
 * expiry date, so we assume 170 days and ask Emily to re-consent before that,
 * rather than discovering it broke at 11pm on a Saturday.
 *
 * The environment is part of the key. Sandbox and production are different
 * sellers with different accounts, and a sandbox token used against
 * production would publish into the wrong store.
 */

import type { Pool } from 'pg';
import type { EBayEnvironment } from './ebay-client.ts';
import { EBayPolicyError, type EBayTokens } from './ebay-client.ts';

/** Days we assume a refresh token lasts, minus a margin. */
const REFRESH_LIFETIME_DAYS = 170;

export interface StoredEBayTokens {
  sellerId: string;
  environment: EBayEnvironment;
  sellerUserId?: string;
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: string;
  refreshExpiresAt: string;
  scope?: string;
}

export interface EBayTokenStore {
  get(sellerId: string, environment: EBayEnvironment): Promise<StoredEBayTokens | undefined>;
  /** The one connected account, if there is one. */
  first(environment: EBayEnvironment): Promise<StoredEBayTokens | undefined>;
  save(
    sellerId: string,
    environment: EBayEnvironment,
    tokens: EBayTokens & { sellerUserId?: string },
  ): Promise<StoredEBayTokens>;
}

export class MemoryEBayTokenStore implements EBayTokenStore {
  private readonly tokens = new Map<string, StoredEBayTokens>();

  private key(sellerId: string, environment: EBayEnvironment): string {
    return `${environment}:${sellerId}`;
  }

  async get(sellerId: string, environment: EBayEnvironment): Promise<StoredEBayTokens | undefined> {
    return this.tokens.get(this.key(sellerId, environment));
  }

  async first(environment: EBayEnvironment): Promise<StoredEBayTokens | undefined> {
    for (const stored of this.tokens.values()) {
      if (stored.environment === environment) return stored;
    }
    return undefined;
  }

  async save(
    sellerId: string,
    environment: EBayEnvironment,
    tokens: EBayTokens & { sellerUserId?: string },
  ): Promise<StoredEBayTokens> {
    const now = Date.now();
    const existing = this.tokens.get(this.key(sellerId, environment));
    // A refresh grant does not always return a new refresh token. Keeping the
    // old one is correct — eBay's old one is still valid.
    const refreshToken = tokens.refreshToken ?? existing?.refreshToken;
    if (!refreshToken) {
      throw new EBayPolicyError(
        'ebay_refresh_token_missing',
        'ebay did not return a refresh token, so the account cannot be kept connected',
      );
    }
    const stored: StoredEBayTokens = {
      sellerId,
      environment,
      sellerUserId: tokens.sellerUserId ?? existing?.sellerUserId,
      accessToken: tokens.accessToken,
      refreshToken,
      accessExpiresAt: new Date(now + Math.max(0, tokens.expiresIn) * 1000).toISOString(),
      refreshExpiresAt: new Date(now + REFRESH_LIFETIME_DAYS * 86_400_000).toISOString(),
      scope: tokens.scope ?? existing?.scope ?? '',
    };
    this.tokens.set(this.key(sellerId, environment), stored);
    return stored;
  }
}

interface EBayTokenRow {
  seller_id: string;
  environment: EBayEnvironment;
  seller_user_id: string | null;
  access_token: string;
  refresh_token: string;
  access_expires_at: Date;
  refresh_expires_at: Date;
  scope: string;
}

function toStored(row: EBayTokenRow): StoredEBayTokens {
  const stored: StoredEBayTokens = {
    sellerId: row.seller_id,
    environment: row.environment,
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    accessExpiresAt: row.access_expires_at.toISOString(),
    refreshExpiresAt: row.refresh_expires_at.toISOString(),
    scope: row.scope,
  };
  if (row.seller_user_id) stored.sellerUserId = row.seller_user_id;
  return stored;
}

export class PgEBayTokenStore implements EBayTokenStore {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async get(sellerId: string, environment: EBayEnvironment): Promise<StoredEBayTokens | undefined> {
    const result = await this.pool.query<EBayTokenRow>(
      `SELECT seller_id, environment, seller_user_id, access_token, refresh_token,
              access_expires_at, refresh_expires_at, scope
         FROM ebay_tokens WHERE seller_id = $1 AND environment = $2`,
      [sellerId, environment],
    );
    return result.rows[0] ? toStored(result.rows[0]) : undefined;
  }

  async first(environment: EBayEnvironment): Promise<StoredEBayTokens | undefined> {
    const result = await this.pool.query<EBayTokenRow>(
      `SELECT seller_id, environment, seller_user_id, access_token, refresh_token,
              access_expires_at, refresh_expires_at, scope
         FROM ebay_tokens WHERE environment = $1 ORDER BY updated_at DESC LIMIT 1`,
      [environment],
    );
    return result.rows[0] ? toStored(result.rows[0]) : undefined;
  }

  async save(
    sellerId: string,
    environment: EBayEnvironment,
    tokens: EBayTokens & { sellerUserId?: string },
  ): Promise<StoredEBayTokens> {
    const now = Date.now();
    const accessExpiresAt = new Date(now + Math.max(0, tokens.expiresIn) * 1000).toISOString();
    const refreshExpiresAt = new Date(now + REFRESH_LIFETIME_DAYS * 86_400_000).toISOString();
    // A refresh grant does not always return a new refresh token. Keeping the
    // old one is correct — eBay's old one is still valid.
    const existing = await this.get(sellerId, environment);
    const refreshToken = tokens.refreshToken ?? existing?.refreshToken;
    if (!refreshToken) {
      throw new EBayPolicyError(
        'ebay_refresh_token_missing',
        'ebay did not return a refresh token, so the account cannot be kept connected',
      );
    }
    const result = await this.pool.query<EBayTokenRow>(
      `INSERT INTO ebay_tokens
         (seller_id, environment, seller_user_id, access_token, refresh_token,
          access_expires_at, refresh_expires_at, scope)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (seller_id) DO UPDATE
         SET environment        = EXCLUDED.environment,
             seller_user_id     = COALESCE(EXCLUDED.seller_user_id, ebay_tokens.seller_user_id),
             access_token       = EXCLUDED.access_token,
             refresh_token      = EXCLUDED.refresh_token,
             access_expires_at  = EXCLUDED.access_expires_at,
             refresh_expires_at = EXCLUDED.refresh_expires_at,
             scope              = EXCLUDED.scope,
             updated_at         = now()
       RETURNING seller_id, environment, seller_user_id, access_token, refresh_token,
                 access_expires_at, refresh_expires_at, scope`,
      [
        sellerId,
        environment,
        tokens.sellerUserId ?? null,
        tokens.accessToken,
        refreshToken,
        accessExpiresAt,
        refreshExpiresAt,
        tokens.scope ?? '',
      ],
    );
    return toStored(result.rows[0]);
  }
}

/**
 * Hands the adapter a usable access token.
 *
 * A seller token is what can publish. An app token (client credentials) is
 * not enough: eBay's Sell Inventory API needs a token that is bound to a
 * seller, so a missing seller token is an error, not a fallback.
 */
export class EBayTokenManager {
  private readonly client: { refreshAccessToken(refreshToken: string): Promise<EBayTokens> };
  private readonly store: EBayTokenStore;
  private readonly environment: EBayEnvironment;
  private readonly sellerId?: string;

  constructor(
    client: { refreshAccessToken(refreshToken: string): Promise<EBayTokens> },
    store: EBayTokenStore,
    environment: EBayEnvironment,
    sellerId?: string,
  ) {
    this.client = client;
    this.store = store;
    this.environment = environment;
    this.sellerId = sellerId;
  }

  async accessToken(): Promise<string> {
    if (this.sellerId) return this.tokenFor(this.sellerId);
    const stored = await this.store.first(this.environment);
    if (!stored) {
      throw new EBayPolicyError(
        'ebay_not_connected',
        'the eBay account is not connected yet; Emily has to connect it herself',
      );
    }
    return this.tokenFor(stored.sellerId, stored);
  }

  private async tokenFor(sellerId: string, known?: StoredEBayTokens): Promise<string> {
    const stored = known ?? (await this.store.get(sellerId, this.environment));
    if (!stored) {
      throw new EBayPolicyError(
        'ebay_not_connected',
        'the eBay account is not connected yet; Emily has to connect it herself',
      );
    }
    // A token that is about to expire is refreshed now, not in a minute.
    if (Date.parse(stored.accessExpiresAt) > Date.now() + 30_000) {
      return stored.accessToken;
    }
    if (Date.parse(stored.refreshExpiresAt) <= Date.now()) {
      throw new EBayPolicyError(
        'ebay_reconsent_required',
        'the eBay refresh token has expired; the account has to be connected again',
      );
    }
    const refreshed = await this.client.refreshAccessToken(stored.refreshToken);
    await this.store.save(sellerId, this.environment, {
      accessToken: refreshed.accessToken,
      tokenType: refreshed.tokenType,
      refreshToken: refreshed.refreshToken || stored.refreshToken,
      expiresIn: refreshed.expiresIn,
      scope: refreshed.scope,
      sellerUserId: stored.sellerUserId,
    });
    return refreshed.accessToken;
  }
}
