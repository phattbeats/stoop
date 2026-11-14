/**
 * Stoop — draft storage.
 *
 * Two implementations, one contract: an in-memory store for tests and the
 * Postgres store for the running app. Same shape as the ledger split
 * (src/ledger.ts vs src/store.ts), because a draft that behaves differently
 * in tests than in production is a draft nobody can trust.
 */

import type { Pool } from 'pg';
import type { ListingDraft, ShippingOption } from './draft.ts';

export interface DraftStore {
  create(draft: ListingDraft): Promise<ListingDraft>;
  get(id: string): Promise<ListingDraft | undefined>;
  listForSeller(sellerId: string): Promise<ListingDraft[]>;
  /** Persist a decided draft (approved/rejected). */
  save(draft: ListingDraft): Promise<ListingDraft>;
}

export class MemoryDraftStore implements DraftStore {
  private readonly drafts = new Map<string, ListingDraft>();

  async create(draft: ListingDraft): Promise<ListingDraft> {
    this.drafts.set(draft.id, draft);
    return draft;
  }

  async get(id: string): Promise<ListingDraft | undefined> {
    return this.drafts.get(id);
  }

  async listForSeller(sellerId: string): Promise<ListingDraft[]> {
    return [...this.drafts.values()]
      .filter((draft) => draft.sellerId === sellerId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async save(draft: ListingDraft): Promise<ListingDraft> {
    this.drafts.set(draft.id, draft);
    return draft;
  }
}

interface DraftRow {
  id: string;
  seller_id: string;
  item_id: string | null;
  status: ListingDraft['status'];
  title: string;
  description: string;
  tags: string[] | null;
  price_low_cents: number;
  price_high_cents: number;
  shipping: unknown;
  photos: unknown;
  notes: string;
  original_or_vintage: boolean | null;
  condition: string;
  confidence: number;
  flags: string[] | null;
  created_at: Date;
  decided_at: Date | null;
}

function toDraft(row: DraftRow): ListingDraft {
  const shipping: ShippingOption[] = Array.isArray(row.shipping)
    ? (row.shipping as unknown[]).filter(
        (option): option is ShippingOption =>
          typeof option === 'object' && option !== null && typeof (option as ShippingOption).label === 'string',
      )
    : [];
  const photos = Array.isArray(row.photos)
    ? (row.photos as unknown[]).filter((photo): photo is string => typeof photo === 'string')
    : [];
  const draft: ListingDraft = {
    id: row.id,
    sellerId: row.seller_id,
    status: row.status,
    title: row.title,
    description: row.description,
    tags: row.tags ?? [],
    priceRange: { lowCents: row.price_low_cents, highCents: row.price_high_cents },
    shipping,
    photos,
    notes: row.notes,
    originalOrVintage: row.original_or_vintage,
    condition: row.condition,
    confidence: row.confidence,
    flags: row.flags ?? [],
    createdAt: new Date(row.created_at).toISOString(),
  };
  if (row.item_id) draft.itemId = row.item_id;
  if (row.decided_at) draft.decidedAt = new Date(row.decided_at).toISOString();
  return draft;
}

export class PgDraftStore implements DraftStore {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async create(draft: ListingDraft): Promise<ListingDraft> {
    const result = await this.pool.query<DraftRow>(
      `INSERT INTO listing_drafts
         (id, seller_id, status, title, description, tags, price_low_cents, price_high_cents,
          shipping, photos, notes, original_or_vintage, condition, confidence, flags)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$13,$14,$15)
       RETURNING *`,
      [
        draft.id,
        draft.sellerId,
        draft.status,
        draft.title,
        draft.description,
        draft.tags,
        draft.priceRange.lowCents,
        draft.priceRange.highCents,
        JSON.stringify(draft.shipping),
        JSON.stringify(draft.photos),
        draft.notes,
        draft.originalOrVintage,
        draft.condition,
        draft.confidence,
        draft.flags,
      ],
    );
    return toDraft(result.rows[0]);
  }

  async get(id: string): Promise<ListingDraft | undefined> {
    const result = await this.pool.query<DraftRow>(`SELECT * FROM listing_drafts WHERE id = $1`, [id]);
    const row = result.rows[0];
    return row ? toDraft(row) : undefined;
  }

  async listForSeller(sellerId: string): Promise<ListingDraft[]> {
    const result = await this.pool.query<DraftRow>(
      `SELECT * FROM listing_drafts WHERE seller_id = $1 ORDER BY created_at ASC`,
      [sellerId],
    );
    return result.rows.map(toDraft);
  }

  async save(draft: ListingDraft): Promise<ListingDraft> {
    const result = await this.pool.query<DraftRow>(
      `UPDATE listing_drafts
          SET status = $2, item_id = $3, decided_at = $4, title = $5, description = $6, tags = $7
        WHERE id = $1
        RETURNING *`,
      [
        draft.id,
        draft.status,
        draft.itemId ?? null,
        draft.decidedAt ?? null,
        draft.title,
        draft.description,
        draft.tags,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error(`unknown draft ${draft.id}`);
    return toDraft(row);
  }
}
