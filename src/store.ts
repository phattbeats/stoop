/**
 * Stoop — Postgres-backed inventory ledger.
 *
 * Same contract as the in-memory reference ledger (src/ledger.ts): one record
 * per item, one listing per marketplace, one sale per item. The rules live in
 * src/domain.ts so the two implementations cannot drift; test/store.test.ts
 * runs the same break-test scenario through both.
 *
 * The two constraints that carry the product are database constraints:
 *   listings UNIQUE (item_id, marketplace)
 *   sales    UNIQUE (item_id)
 */

import type { Pool, PoolClient } from 'pg';
import type { Item, Listing, Marketplace, Sale, SaleResult, SaleSignal, Seller } from './ledger.ts';
import {
  assertEditable,
  assertNotFacebookPublish,
  assertPublishable,
  cleanPhotos,
  cleanTags,
  listingsEndedBySale,
  requireReceipt,
  saleDecision,
} from './domain.ts';

interface ItemRow {
  id: string;
  seller_id: string;
  title: string;
  description: string;
  price_cents: number;
  photos: unknown;
  tags: string[] | null;
  condition: string;
  original_or_vintage: boolean | null;
  status: Item['status'];
  created_at: Date;
}

interface ListingRow {
  id: string;
  item_id: string;
  marketplace: Marketplace;
  remote_id: string | null;
  state: Listing['state'];
  created_at: Date;
  ended_at: Date | null;
  end_reason: string | null;
}

interface SellerRow {
  id: string;
  auth_user_id: string;
  display_name: string;
}

function toItem(row: ItemRow): Item {
  const photos = Array.isArray(row.photos)
    ? (row.photos as unknown[]).filter((photo): photo is string => typeof photo === 'string')
    : [];
  return {
    id: row.id,
    sellerId: row.seller_id,
    title: row.title,
    description: row.description,
    priceCents: row.price_cents,
    photos,
    tags: row.tags ?? [],
    condition: row.condition,
    originalOrVintage: row.original_or_vintage,
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function toListing(row: ListingRow): Listing {
  const listing: Listing = {
    id: row.id,
    itemId: row.item_id,
    marketplace: row.marketplace,
    remoteId: row.remote_id,
    state: row.state,
    createdAt: new Date(row.created_at).toISOString(),
  };
  if (row.ended_at) listing.endedAt = new Date(row.ended_at).toISOString();
  if (row.end_reason) listing.endReason = row.end_reason;
  return listing;
}

export class PgLedger {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  // ── sellers ────────────────────────────────────────────────────────────────

  async addSeller(seller: Seller): Promise<Seller> {
    const result = await this.pool.query<SellerRow>(
      `INSERT INTO sellers (auth_user_id, display_name)
            VALUES ($1, $2)
       ON CONFLICT (auth_user_id)
       DO UPDATE SET display_name = EXCLUDED.display_name
         RETURNING id, auth_user_id, display_name`,
      [seller.authUserId, seller.displayName],
    );
    const row = result.rows[0];
    return { id: row.id, authUserId: row.auth_user_id, displayName: row.display_name };
  }

  async getSeller(id: string): Promise<Seller | undefined> {
    const result = await this.pool.query<SellerRow>(
      `SELECT id, auth_user_id, display_name FROM sellers WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row ? { id: row.id, authUserId: row.auth_user_id, displayName: row.display_name } : undefined;
  }

  async findSellerByAuthUserId(authUserId: string): Promise<Seller | undefined> {
    const result = await this.pool.query<SellerRow>(
      `SELECT id, auth_user_id, display_name FROM sellers WHERE auth_user_id = $1`,
      [authUserId],
    );
    const row = result.rows[0];
    return row ? { id: row.id, authUserId: row.auth_user_id, displayName: row.display_name } : undefined;
  }

  // ── items ──────────────────────────────────────────────────────────────────

  async createItem(input: {
    sellerId: string;
    title: string;
    description?: string;
    priceCents: number;
    photos?: string[];
    tags?: string[];
    condition?: string;
    originalOrVintage?: boolean | null;
  }): Promise<Item> {
    const result = await this.pool.query<ItemRow>(
      `INSERT INTO items (seller_id, title, description, price_cents, photos, tags, condition, original_or_vintage, status)
            VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, 'draft')
         RETURNING id, seller_id, title, description, price_cents, photos, tags, condition, original_or_vintage, status, created_at`,
      [
        input.sellerId,
        input.title,
        input.description ?? '',
        input.priceCents,
        JSON.stringify(cleanPhotos(input.photos)),
        cleanTags(input.tags),
        input.condition ?? 'unspecified',
        input.originalOrVintage ?? null,
      ],
    );
    return toItem(result.rows[0]);
  }

  async getItem(id: string): Promise<Item | undefined> {
    const result = await this.pool.query<ItemRow>(
      `SELECT id, seller_id, title, description, price_cents, photos, tags, condition, original_or_vintage, status, created_at
         FROM items WHERE id = $1`,
      [id],
    );
    return result.rows[0] ? toItem(result.rows[0]) : undefined;
  }

  async listItems(sellerId?: string): Promise<Item[]> {
    const result = sellerId
      ? await this.pool.query<ItemRow>(
          `SELECT id, seller_id, title, description, price_cents, photos, tags, condition, original_or_vintage, status, created_at
             FROM items WHERE seller_id = $1 ORDER BY created_at DESC`,
          [sellerId],
        )
      : await this.pool.query<ItemRow>(
          `SELECT id, seller_id, title, description, price_cents, photos, tags, condition, original_or_vintage, status, created_at
             FROM items ORDER BY created_at DESC`,
        );
    return result.rows.map(toItem);
  }

  /**
   * Edit the facts of an item that nothing else is published from yet.
   *
   * Once an item is live on eBay or Etsy the record is frozen: those
   * listings cannot be revised in place, so the record they were published
   * from has to stay true.
   */
  async updateItem(
    itemId: string,
    patch: {
      title?: string;
      description?: string;
      priceCents?: number;
      condition?: string;
      originalOrVintage?: boolean | null;
    },
  ): Promise<Item> {
    const item = await this.getItem(itemId);
    if (!item) throw new Error(`unknown item ${itemId}`);
    const listings = await this.listListings(itemId);
    assertEditable(item, listings);

    const title = patch.title !== undefined ? patch.title.trim().slice(0, 140) : item.title;
    const description =
      patch.description !== undefined ? patch.description.trim().slice(0, 4000) : item.description;
    const priceCents =
      patch.priceCents !== undefined
        ? (() => {
            if (!Number.isFinite(patch.priceCents) || (patch.priceCents as number) < 0) {
              throw new Error('price must be a non-negative number of cents');
            }
            return Math.round(patch.priceCents as number);
          })()
        : item.priceCents;
    const condition =
      patch.condition !== undefined
        ? patch.condition.trim().slice(0, 40) || 'unspecified'
        : item.condition;
    const originalOrVintage =
      patch.originalOrVintage !== undefined ? patch.originalOrVintage : item.originalOrVintage;

    const result = await this.pool.query<ItemRow>(
      `UPDATE items
          SET title = $2, description = $3, price_cents = $4, condition = $5, original_or_vintage = $6
        WHERE id = $1
        RETURNING id, seller_id, title, description, price_cents, photos, tags, condition, original_or_vintage, status, created_at`,
      [itemId, title, description, priceCents, condition, originalOrVintage],
    );
    return toItem(result.rows[0]);
  }

  // ── listings ───────────────────────────────────────────────────────────────

  async listListings(itemId?: string): Promise<Listing[]> {
    const result = itemId
      ? await this.pool.query<ListingRow>(
          `SELECT id, item_id, marketplace, remote_id, state, created_at, ended_at, end_reason
             FROM listings WHERE item_id = $1 ORDER BY created_at`,
          [itemId],
        )
      : await this.pool.query<ListingRow>(
          `SELECT id, item_id, marketplace, remote_id, state, created_at, ended_at, end_reason
             FROM listings ORDER BY created_at`,
        );
    return result.rows.map(toListing);
  }

  /**
   * The listing that a marketplace told us about.
   *
   * A sale arrives naming a remote id (an Etsy listing id), not one of ours,
   * so this is how a marketplace event finds the item it belongs to.
   */
  async findListingByRemoteId(marketplace: Marketplace, remoteId: string): Promise<Listing | undefined> {
    const result = await this.pool.query<ListingRow>(
      `SELECT id, item_id, marketplace, remote_id, state, created_at, ended_at, end_reason
         FROM listings WHERE marketplace = $1 AND remote_id = $2 LIMIT 1`,
      [marketplace, remoteId],
    );
    return result.rows[0] ? toListing(result.rows[0]) : undefined;
  }

  /**
   * Publish (or revise) the item on one marketplace.
   *
   * Revising in place is the point: eBay Inventory-API listings cannot be
   * revised in Seller Hub, so the API is the only editor and there is never
   * more than one listing per (item, marketplace).
   */
  async publish(itemId: string, marketplace: Marketplace, remoteId: string | null): Promise<Listing> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const item = await this.fetchItem(client, itemId);
      if (!item) throw new Error(`unknown item ${itemId}`);
      assertPublishable(item);
      assertNotFacebookPublish(marketplace);

      const result = await client.query<ListingRow>(
        `INSERT INTO listings (item_id, marketplace, remote_id, state)
              VALUES ($1, $2, $3, 'live')
         ON CONFLICT (item_id, marketplace)
         DO UPDATE SET remote_id = COALESCE(EXCLUDED.remote_id, listings.remote_id),
                       state = 'live',
                       ended_at = NULL,
                       end_reason = NULL
           RETURNING id, item_id, marketplace, remote_id, state, created_at, ended_at, end_reason`,
        [itemId, marketplace, remoteId],
      );
      await client.query(`UPDATE items SET status = 'published' WHERE id = $1`, [itemId]);
      await client.query('COMMIT');
      return toListing(result.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * The "Posted on FB" tap.
   *
   * She pasted the card into Facebook and says it is up. There is no Facebook
   * listing id to store — Stoop never touches Facebook — so the listing is a
   * state: marketplace facebook, remote id null, live.
   */
  async markPostedOnFacebook(itemId: string): Promise<Listing> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const item = await this.fetchItem(client, itemId);
      if (!item) throw new Error(`unknown item ${itemId}`);
      assertPublishable(item);

      const result = await client.query<ListingRow>(
        `INSERT INTO listings (item_id, marketplace, remote_id, state)
              VALUES ($1, 'facebook', NULL, 'live')
         ON CONFLICT (item_id, marketplace)
         DO UPDATE SET remote_id = NULL,
                       state = 'live',
                       ended_at = NULL,
                       end_reason = NULL
           RETURNING id, item_id, marketplace, remote_id, state, created_at, ended_at, end_reason`,
        [itemId],
      );
      await client.query(`UPDATE items SET status = 'published' WHERE id = $1`, [itemId]);
      await client.query('COMMIT');
      return toListing(result.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // ── sales ──────────────────────────────────────────────────────────────────

  async isSold(itemId: string): Promise<boolean> {
    const result = await this.pool.query(`SELECT 1 FROM sales WHERE item_id = $1`, [itemId]);
    return (result.rowCount ?? 0) > 0;
  }

  async getSale(itemId: string): Promise<Sale | undefined> {
    const result = await this.pool.query(
      `SELECT id, item_id, marketplace, order_id, amount_cents, occurred_at, receipt
         FROM sales WHERE item_id = $1`,
      [itemId],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      id: row.id,
      itemId: row.item_id,
      marketplace: row.marketplace,
      orderId: row.order_id,
      amountCents: row.amount_cents,
      occurredAt: new Date(row.occurred_at).toISOString(),
      receipt: row.receipt,
    };
  }

  async getDuplicateSales(itemId: string): Promise<Sale[]> {
    const result = await this.pool.query(
      `SELECT id, item_id, marketplace, order_id, amount_cents, occurred_at, receipt
         FROM duplicate_sales WHERE item_id = $1 ORDER BY created_at`,
      [itemId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      itemId: row.item_id,
      marketplace: row.marketplace,
      orderId: row.order_id,
      amountCents: row.amount_cents,
      occurredAt: new Date(row.occurred_at).toISOString(),
      receipt: row.receipt,
    }));
  }

  /**
   * Record a sale signal.
   *
   * Order of authority: idempotency first, receipt second, one sale per item
   * third. A second real-world sale is recorded as a duplicate that needs a
   * refund — the money moved even though the item did not.
   */
  async recordSale(signal: SaleSignal): Promise<SaleResult> {
    const receipt = requireReceipt(signal.receipt, signal.eventId);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const item = await this.fetchItem(client, signal.itemId);
      if (!item) throw new Error(`unknown item ${signal.itemId}`);

      // A redelivered webhook (Etsy retries) changes nothing.
      const seen = await client.query(`SELECT 1 FROM order_events WHERE event_id = $1`, [signal.eventId]);
      if ((seen.rowCount ?? 0) > 0) {
        await client.query('ROLLBACK');
        return { outcome: 'ignored_duplicate_webhook', endedListings: [], needsRefund: false };
      }

      const existing = await client.query(
        `SELECT id FROM sales WHERE item_id = $1 FOR UPDATE`,
        [signal.itemId],
      );
      const decision = saleDecision(existing.rows[0]);

      if (decision === 'suppress_duplicate') {
        const duplicate = await client.query(
          `INSERT INTO duplicate_sales (item_id, marketplace, order_id, amount_cents, occurred_at, receipt, needs_refund)
                VALUES ($1, $2, $3, $4, $5, $6::jsonb, true)
           ON CONFLICT (marketplace, order_id) DO UPDATE SET needs_refund = true
             RETURNING id, item_id, marketplace, order_id, amount_cents, occurred_at, receipt`,
          [
            signal.itemId,
            signal.marketplace,
            signal.orderId,
            signal.amountCents,
            signal.occurredAt,
            JSON.stringify(receipt),
          ],
        );
        await this.recordEvent(client, signal, 'suppressed_duplicate_sale');
        await client.query('COMMIT');
        const row = duplicate.rows[0];
        return {
          outcome: 'suppressed_duplicate_sale',
          sale: {
            id: row.id,
            itemId: row.item_id,
            marketplace: row.marketplace,
            orderId: row.order_id,
            amountCents: row.amount_cents,
            occurredAt: new Date(row.occurred_at).toISOString(),
            receipt: row.receipt,
          },
          endedListings: [],
          needsRefund: true,
        };
      }

      const sale = await client.query(
        `INSERT INTO sales (item_id, marketplace, order_id, amount_cents, occurred_at, receipt)
              VALUES ($1, $2, $3, $4, $5, $6::jsonb)
           RETURNING id, item_id, marketplace, order_id, amount_cents, occurred_at, receipt`,
        [
          signal.itemId,
          signal.marketplace,
          signal.orderId,
          signal.amountCents,
          signal.occurredAt,
          JSON.stringify(receipt),
        ],
      );
      await client.query(`UPDATE items SET status = 'sold' WHERE id = $1`, [signal.itemId]);

      // A sale anywhere ends every other listing. No human in the loop.
      const ended = await client.query<ListingRow>(
        `UPDATE listings
            SET state = 'ended', ended_at = now(), end_reason = $3
          WHERE item_id = $1 AND state <> 'ended' AND marketplace <> $2
       RETURNING id, item_id, marketplace, remote_id, state, created_at, ended_at, end_reason`,
        [signal.itemId, signal.marketplace, `sold_on_${signal.marketplace}`],
      );
      const endedListings = ended.rows.map(toListing);

      await this.recordEvent(client, signal, 'sale_recorded');
      await client.query('COMMIT');

      const row = sale.rows[0];
      return {
        outcome: 'sale_recorded',
        sale: {
          id: row.id,
          itemId: row.item_id,
          marketplace: row.marketplace,
          orderId: row.order_id,
          amountCents: row.amount_cents,
          occurredAt: new Date(row.occurred_at).toISOString(),
          receipt: row.receipt,
        },
        endedListings,
        needsRefund: false,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      // A redelivered webhook that raced another delivery changes nothing.
      if (isUniqueViolation(error)) {
        return { outcome: 'ignored_duplicate_webhook', endedListings: [], needsRefund: false };
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /** The Facebook "Mark sold" tap: the seller says it sold there. */
  async markSold(itemId: string, eventId: string): Promise<SaleResult> {
    const item = await this.getItem(itemId);
    if (!item) throw new Error(`unknown item ${itemId}`);
    return this.recordSale({
      eventId,
      marketplace: 'facebook',
      orderId: `manual_${eventId}`,
      itemId,
      amountCents: item.priceCents,
      occurredAt: new Date().toISOString(),
      receipt: { source: 'manual_mark_sold', itemId },
    });
  }

  private async recordEvent(
    client: PoolClient,
    signal: SaleSignal,
    outcome: 'sale_recorded' | 'suppressed_duplicate_sale',
  ): Promise<void> {
    try {
      await client.query(
        `INSERT INTO order_events (event_id, marketplace, order_id, item_id, outcome, payload)
              VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         ON CONFLICT (event_id) DO NOTHING`,
        [
          signal.eventId,
          signal.marketplace,
          signal.orderId,
          signal.itemId,
          outcome,
          JSON.stringify(signal.receipt),
        ],
      );
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
  }

  private async fetchItem(client: PoolClient, itemId: string): Promise<Item | undefined> {
    const result = await client.query<ItemRow>(
      `SELECT id, seller_id, title, description, price_cents, photos, tags, condition, original_or_vintage, status, created_at
         FROM items WHERE id = $1`,
      [itemId],
    );
    return result.rows[0] ? toItem(result.rows[0]) : undefined;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505';
}
