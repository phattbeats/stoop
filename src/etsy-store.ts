/**
 * Stoop — the Etsy token store and the remote action queue.
 *
 * Two implementations each: Postgres for the running app, memory for tests.
 * Same split as the ledger (src/ledger.ts vs src/store.ts): a token or a
 * queued action that behaves differently in tests than in production is not
 * worth having.
 *
 * The refresh deadline is stored rather than computed at read time because
 * Etsy's refresh token has a ~90 day *functional* lifetime, not a documented
 * expiry date. We assume 80 days and ask Emily to re-consent before that,
 * rather than discovering it broke at 11pm on a Saturday.
 */

import type { Pool } from 'pg';
import type { Marketplace } from './ledger.ts';
import type { EtsyTokenProvider } from './etsy.ts';
import { EtsyClient, EtsyPolicyError, type EtsyTokens } from './etsy.ts';

/** Days we assume a refresh token lasts, minus a margin. */
const REFRESH_LIFETIME_DAYS = 80;

export interface StoredEtsyTokens {
  sellerId: string;
  shopId?: string;
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: string;
  refreshExpiresAt: string;
  scope?: string;
}

export interface EtsyTokenStore {
  get(sellerId: string): Promise<StoredEtsyTokens | undefined>;
  getByShopId(shopId: string): Promise<StoredEtsyTokens | undefined>;
  /** The one connected account, if there is one. */
  first(): Promise<StoredEtsyTokens | undefined>;
  save(sellerId: string, tokens: EtsyTokens & { shopId?: string }): Promise<StoredEtsyTokens>;
}

export class MemoryEtsyTokenStore implements EtsyTokenStore {
  private readonly tokens = new Map<string, StoredEtsyTokens>();

  async get(sellerId: string): Promise<StoredEtsyTokens | undefined> {
    return this.tokens.get(sellerId);
  }

  async getByShopId(shopId: string): Promise<StoredEtsyTokens | undefined> {
    for (const stored of this.tokens.values()) {
      if (stored.shopId === shopId) return stored;
    }
    return undefined;
  }

  async first(): Promise<StoredEtsyTokens | undefined> {
    for (const stored of this.tokens.values()) return stored;
    return undefined;
  }

  async save(sellerId: string, tokens: EtsyTokens & { shopId?: string }): Promise<StoredEtsyTokens> {
    const now = Date.now();
    const existing = this.tokens.get(sellerId);
    const stored: StoredEtsyTokens = {
      sellerId,
      shopId: tokens.shopId ?? existing?.shopId,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      accessExpiresAt: new Date(now + Math.max(0, tokens.expiresIn) * 1000).toISOString(),
      refreshExpiresAt: new Date(now + REFRESH_LIFETIME_DAYS * 86_400_000).toISOString(),
      scope: tokens.scope ?? existing?.scope ?? '',
    };
    this.tokens.set(sellerId, stored);
    return stored;
  }
}

interface EtsyTokenRow {
  seller_id: string;
  shop_id: string | null;
  access_token: string;
  refresh_token: string;
  access_expires_at: Date;
  refresh_expires_at: Date;
  scope: string;
}

function toStored(row: EtsyTokenRow): StoredEtsyTokens {
  const stored: StoredEtsyTokens = {
    sellerId: row.seller_id,
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    accessExpiresAt: new Date(row.access_expires_at).toISOString(),
    refreshExpiresAt: new Date(row.refresh_expires_at).toISOString(),
    scope: row.scope,
  };
  if (row.shop_id !== null) stored.shopId = String(row.shop_id);
  return stored;
}

export class PgEtsyTokenStore implements EtsyTokenStore {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async get(sellerId: string): Promise<StoredEtsyTokens | undefined> {
    const result = await this.pool.query<EtsyTokenRow>(
      `SELECT seller_id, shop_id, access_token, refresh_token, access_expires_at, refresh_expires_at, scope
         FROM etsy_tokens WHERE seller_id = $1`,
      [sellerId],
    );
    return result.rows[0] ? toStored(result.rows[0]) : undefined;
  }

  async getByShopId(shopId: string): Promise<StoredEtsyTokens | undefined> {
    const result = await this.pool.query<EtsyTokenRow>(
      `SELECT seller_id, shop_id, access_token, refresh_token, access_expires_at, refresh_expires_at, scope
         FROM etsy_tokens WHERE shop_id = $1 LIMIT 1`,
      [shopId],
    );
    return result.rows[0] ? toStored(result.rows[0]) : undefined;
  }

  async first(): Promise<StoredEtsyTokens | undefined> {
    const result = await this.pool.query<EtsyTokenRow>(
      `SELECT seller_id, shop_id, access_token, refresh_token, access_expires_at, refresh_expires_at, scope
         FROM etsy_tokens ORDER BY updated_at DESC LIMIT 1`,
    );
    return result.rows[0] ? toStored(result.rows[0]) : undefined;
  }

  async save(sellerId: string, tokens: EtsyTokens & { shopId?: string }): Promise<StoredEtsyTokens> {
    const now = Date.now();
    const accessExpiresAt = new Date(now + Math.max(0, tokens.expiresIn) * 1000).toISOString();
    const refreshExpiresAt = new Date(now + REFRESH_LIFETIME_DAYS * 86_400_000).toISOString();
    const result = await this.pool.query<EtsyTokenRow>(
      `INSERT INTO etsy_tokens
         (seller_id, shop_id, access_token, refresh_token, access_expires_at, refresh_expires_at, scope)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (seller_id) DO UPDATE
         SET shop_id             = COALESCE(EXCLUDED.shop_id, etsy_tokens.shop_id),
             access_token        = EXCLUDED.access_token,
             refresh_token       = EXCLUDED.refresh_token,
             access_expires_at   = EXCLUDED.access_expires_at,
             refresh_expires_at  = EXCLUDED.refresh_expires_at,
             scope               = EXCLUDED.scope,
             updated_at          = now()
       RETURNING seller_id, shop_id, access_token, refresh_token, access_expires_at, refresh_expires_at, scope`,
      [
        sellerId,
        tokens.shopId ?? null,
        tokens.accessToken,
        tokens.refreshToken,
        accessExpiresAt,
        refreshExpiresAt,
        tokens.scope ?? '',
      ],
    );
    return toStored(result.rows[0]);
  }
}

/**
 * Hands out access tokens and refreshes them when they are old.
 *
 * The refresh is here rather than in the adapter because the one-hour access
 * token is not a thing worth remembering, and because a refresh that fails
 * means "Emily has to consent again", which is a human problem and must be
 * reported as one.
 */
export class EtsyTokenManager implements EtsyTokenProvider {
  private readonly client: EtsyClient;
  private readonly store: EtsyTokenStore;
  private readonly sellerId?: string;

  constructor(client: EtsyClient, store: EtsyTokenStore, sellerId?: string) {
    this.client = client;
    this.store = store;
    this.sellerId = sellerId;
  }

  /** The connected seller's access token. */
  async accessToken(): Promise<string> {
    if (this.sellerId) return this.tokenFor(this.sellerId);
    const stored = await this.store.first();
    if (!stored) {
      throw new EtsyPolicyError('etsy_not_connected', 'the etsy account is not connected yet');
    }
    return this.tokenFor(stored.sellerId, stored);
  }

  /** The access token for the shop a webhook names. */
  async accessTokenForShop(shopId: string): Promise<string> {
    const stored = await this.store.getByShopId(shopId);
    if (!stored) {
      throw new EtsyPolicyError('etsy_shop_not_connected', `no etsy account is connected for shop ${shopId}`);
    }
    return this.tokenFor(stored.sellerId, stored);
  }

  private async tokenFor(sellerId: string, known?: StoredEtsyTokens): Promise<string> {
    const stored = known ?? (await this.store.get(sellerId));
    if (!stored) {
      throw new EtsyPolicyError('etsy_not_connected', 'the etsy account is not connected yet');
    }
    if (Date.parse(stored.accessExpiresAt) > Date.now() + 30_000) {
      return stored.accessToken;
    }
    if (Date.parse(stored.refreshExpiresAt) <= Date.now()) {
      throw new EtsyPolicyError(
        'etsy_reconsent_required',
        'the etsy refresh token has expired; the account has to be connected again',
      );
    }
    const refreshed = await this.client.refresh(stored.refreshToken);
    await this.store.save(sellerId, {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken || stored.refreshToken,
      expiresIn: refreshed.expiresIn,
      scope: refreshed.scope,
      shopId: stored.shopId,
    });
    return refreshed.accessToken;
  }
}

// ── the remote action queue ──────────────────────────────────────────────────

export type RemoteActionState = 'pending' | 'succeeded' | 'failed' | 'needs_human';
export type RemoteActionKind = 'delist' | 'review';

export interface RemoteAction {
  id: string;
  itemId?: string;
  listingId?: string;
  marketplace: Marketplace;
  action: RemoteActionKind;
  remoteId?: string;
  state: RemoteActionState;
  needsHuman: boolean;
  attempts: number;
  detail: Record<string, unknown>;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RemoteActionInput {
  itemId?: string;
  listingId?: string;
  marketplace: Marketplace;
  action: RemoteActionKind;
  remoteId?: string;
  state?: RemoteActionState;
  needsHuman?: boolean;
  detail?: Record<string, unknown>;
  lastError?: string;
}

export interface RemoteActionStore {
  /** Queue an action. Re-queueing the same action does not duplicate it. */
  enqueue(input: RemoteActionInput): Promise<RemoteAction>;
  markSucceeded(id: string, detail?: Record<string, unknown>): Promise<void>;
  markFailed(id: string, error: string, needsHuman?: boolean): Promise<void>;
  listOpen(): Promise<RemoteAction[]>;
}

/** The key that makes a queue idempotent: the same action is the same action. */
export function remoteActionKey(input: RemoteActionInput): string {
  return [input.action, input.marketplace, input.remoteId ?? '', input.itemId ?? ''].join(':');
}

export class MemoryRemoteActionStore implements RemoteActionStore {
  private readonly actions = new Map<string, RemoteAction>();
  private counter = 0;

  async enqueue(input: RemoteActionInput): Promise<RemoteAction> {
    const key = remoteActionKey(input);
    const existing = this.actions.get(key);
    if (existing) return existing;
    this.counter += 1;
    const now = new Date().toISOString();
    const action: RemoteAction = {
      id: `action_${this.counter.toString(36)}`,
      marketplace: input.marketplace,
      action: input.action,
      state: input.state ?? 'pending',
      needsHuman: input.needsHuman ?? false,
      attempts: 0,
      detail: input.detail ?? {},
      createdAt: now,
      updatedAt: now,
    };
    if (input.itemId !== undefined) action.itemId = input.itemId;
    if (input.listingId !== undefined) action.listingId = input.listingId;
    if (input.remoteId !== undefined) action.remoteId = input.remoteId;
    if (input.lastError !== undefined) action.lastError = input.lastError;
    this.actions.set(key, action);
    return action;
  }

  async markSucceeded(id: string, detail?: Record<string, unknown>): Promise<void> {
    const action = this.find(id);
    if (!action) return;
    action.state = 'succeeded';
    action.needsHuman = false;
    action.attempts += 1;
    action.updatedAt = new Date().toISOString();
    if (detail) action.detail = { ...action.detail, ...detail };
  }

  async markFailed(id: string, error: string, needsHuman = true): Promise<void> {
    const action = this.find(id);
    if (!action) return;
    action.state = needsHuman ? 'needs_human' : 'failed';
    action.needsHuman = needsHuman;
    action.attempts += 1;
    action.lastError = error;
    action.updatedAt = new Date().toISOString();
  }

  async listOpen(): Promise<RemoteAction[]> {
    return [...this.actions.values()].filter((a) => a.state !== 'succeeded');
  }

  private find(id: string): RemoteAction | undefined {
    for (const action of this.actions.values()) {
      if (action.id === id) return action;
    }
    return undefined;
  }
}

interface RemoteActionRow {
  id: string;
  item_id: string | null;
  listing_id: string | null;
  marketplace: Marketplace;
  action: RemoteActionKind;
  remote_id: string | null;
  state: RemoteActionState;
  needs_human: boolean;
  attempts: number;
  detail: unknown;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

function toAction(row: RemoteActionRow): RemoteAction {
  const action: RemoteAction = {
    id: row.id,
    marketplace: row.marketplace,
    action: row.action,
    state: row.state,
    needsHuman: row.needs_human,
    attempts: row.attempts,
    detail:
      row.detail && typeof row.detail === 'object' && !Array.isArray(row.detail)
        ? (row.detail as Record<string, unknown>)
        : {},
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
  if (row.item_id !== null) action.itemId = row.item_id;
  if (row.listing_id !== null) action.listingId = row.listing_id;
  if (row.remote_id !== null) action.remoteId = row.remote_id;
  if (row.last_error !== null) action.lastError = row.last_error;
  return action;
}

export class PgRemoteActionStore implements RemoteActionStore {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async enqueue(input: RemoteActionInput): Promise<RemoteAction> {
    const result = await this.pool.query<RemoteActionRow>(
      `INSERT INTO remote_actions
         (dedupe_key, item_id, listing_id, marketplace, action, remote_id, state, needs_human, detail, last_error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
       ON CONFLICT (dedupe_key) DO UPDATE SET updated_at = now()
       RETURNING id, item_id, listing_id, marketplace, action, remote_id, state, needs_human,
                 attempts, detail, last_error, created_at, updated_at`,
      [
        remoteActionKey(input),
        input.itemId ?? null,
        input.listingId ?? null,
        input.marketplace,
        input.action,
        input.remoteId ?? null,
        input.state ?? 'pending',
        input.needsHuman ?? false,
        JSON.stringify(input.detail ?? {}),
        input.lastError ?? null,
      ],
    );
    return toAction(result.rows[0]);
  }

  async markSucceeded(id: string, detail?: Record<string, unknown>): Promise<void> {
    await this.pool.query(
      `UPDATE remote_actions
          SET state = 'succeeded', needs_human = false, attempts = attempts + 1,
              detail = $2::jsonb || detail, last_error = NULL, updated_at = now()
        WHERE id = $1`,
      [id, JSON.stringify(detail ?? {})],
    );
  }

  async markFailed(id: string, error: string, needsHuman = true): Promise<void> {
    await this.pool.query(
      `UPDATE remote_actions
          SET state = $2, needs_human = $3, attempts = attempts + 1, last_error = $4, updated_at = now()
        WHERE id = $1`,
      [id, needsHuman ? 'needs_human' : 'failed', needsHuman, error],
    );
  }

  async listOpen(): Promise<RemoteAction[]> {
    const result = await this.pool.query<RemoteActionRow>(
      `SELECT id, item_id, listing_id, marketplace, action, remote_id, state, needs_human,
              attempts, detail, last_error, created_at, updated_at
         FROM remote_actions WHERE state <> 'succeeded' ORDER BY created_at`,
    );
    return result.rows.map(toAction);
  }
}
