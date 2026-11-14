/**
 * Stoop — the listing drafter's rules.
 *
 * A draft is a *proposal*, not a listing. The model may only ever propose;
 * Emily approves. That separation is the product: eBay inventory listings
 * cannot be revised in Seller Hub, so the thing she approves has to be right
 * the first time.
 *
 * This module holds the pure decisions — normalizing what the model returns,
 * checking it against each marketplace's real constraints, and turning an
 * approved draft into the canonical item record. No network, no database, no
 * model. The model call lives in src/llm.ts; storage lives in src/drafts.ts.
 */

import type { Marketplace } from './ledger.ts';
import { renderFacebookCard, type FacebookCard } from './facebook.ts';

export type DraftStatus = 'draft' | 'approved' | 'rejected';

export interface PriceRange {
  lowCents: number;
  highCents: number;
}

export interface ShippingOption {
  label: string;
  priceCents: number;
  /** Order value (cents) at or above which shipping is free. */
  freeOverCents: number | null;
}

export interface ListingDraft {
  id: string;
  sellerId: string;
  status: DraftStatus;
  title: string;
  description: string;
  tags: string[];
  priceRange: PriceRange;
  shipping: ShippingOption[];
  photos: string[];
  /** What Emily said while capturing: voice-note transcript, typed hints. */
  notes: string;
  /** Etsy is original/vintage only, enforced per item. null = not asserted. */
  originalOrVintage: boolean | null;
  condition: string;
  /** 0..1 — how sure the model is. Low confidence is surfaced, not hidden. */
  confidence: number;
  /** Things a human must check: 'needs_measurement', 'price_unverified', ... */
  flags: string[];
  createdAt: string;
  decidedAt?: string;
  /** Item id once approved. */
  itemId?: string;
}

/** A draft as the phone renders it. */
export interface DraftView {
  id: string;
  status: DraftStatus;
  title: string;
  description: string;
  tags: string[];
  priceRange: PriceRange;
  shipping: ShippingOption[];
  photos: string[];
  notes: string;
  originalOrVintage: boolean | null;
  condition: string;
  confidence: number;
  flags: string[];
  createdAt: string;
  itemId?: string;
}

export function draftView(draft: ListingDraft): DraftView {
  return {
    id: draft.id,
    status: draft.status,
    title: draft.title,
    description: draft.description,
    tags: draft.tags,
    priceRange: draft.priceRange,
    shipping: draft.shipping,
    photos: draft.photos,
    notes: draft.notes,
    originalOrVintage: draft.originalOrVintage,
    condition: draft.condition,
    confidence: draft.confidence,
    flags: draft.flags,
    createdAt: draft.createdAt,
    ...(draft.itemId ? { itemId: draft.itemId } : {}),
  };
}

// ── channel constraints ──────────────────────────────────────────────────────
//
// eBay: title 80 characters, no HTML.
// Etsy: title 140 characters, 13 tags, original/vintage only.
// Facebook: paste card, so it needs to read like a person wrote it, 100 chars.

export const CHANNEL_LIMITS: Record<
  Marketplace,
  { titleMax: number; tagsMax: number; descriptionMax: number }
> = {
  ebay: { titleMax: 80, tagsMax: 12, descriptionMax: 4000 },
  etsy: { titleMax: 140, tagsMax: 13, descriptionMax: 4000 },
  facebook: { titleMax: 100, tagsMax: 0, descriptionMax: 2000 },
};

export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

/** eBay and Etsy both reject markup in titles. */
export function stripMarkup(value: string): string {
  return value.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

export function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Parse a price the model gave us. Dollars ("24.50" or 24.5) or cents (2400)
 * are both plausible in model output, so we take dollars-with-a-decimal-point
 * as dollars and anything else as cents. Ambiguity is resolved by magnitude:
 * a "price" over $10,000 in dollars is a typo, and treating it as cents would
 * silently offer the item for $100.
 */
export function parseMoneyToCents(input: unknown): number | null {
  if (typeof input === 'number' && Number.isFinite(input)) {
    const value = input;
    if (value < 0) return null;
    return Math.round(value * 100);
  }
  if (typeof input !== 'string') return null;
  const cleaned = input.replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100);
}

function cleanString(input: unknown, max: number): string {
  if (typeof input !== 'string') return '';
  return stripMarkup(input).trim().slice(0, max);
}

export function cleanTagList(input: unknown, max: number): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const tag = stripMarkup(raw).trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 40);
    if (!tag || out.includes(tag)) continue;
    out.push(tag);
    if (out.length >= max) break;
  }
  return out;
}

// ── normalization ────────────────────────────────────────────────────────────

export interface NormalizedProposal {
  title: string;
  description: string;
  tags: string[];
  priceRange: PriceRange;
  shipping: ShippingOption[];
  originalOrVintage: boolean | null;
  condition: string;
  confidence: number;
  flags: string[];
  /** Things the model got wrong that we corrected. Surfaced to Emily. */
  corrections: string[];
}

export interface ProposalReview {
  proposal: NormalizedProposal;
  /** Fatal problems: without these there is no draft to approve. */
  problems: string[];
  /** Non-fatal notes worth showing Emily. */
  corrections: string[];
  usable: boolean;
}

/**
 * Turn raw model output into something Emily can actually approve.
 *
 * We clamp rather than reject: a 95-character title is a typo, not a reason to
 * make her retype it. A missing price is fatal, because a listing without a
 * price is not a listing.
 */
export function reviewProposal(raw: unknown): ProposalReview {
  const problems: string[] = [];
  const corrections: string[] = [];
  const input = (raw ?? {}) as Record<string, unknown>;

  const rawTitle = cleanString(input.title, 500);
  if (!rawTitle) problems.push('title_missing');
  const title = truncate(rawTitle, CHANNEL_LIMITS.ebay.titleMax);
  if (title !== rawTitle) corrections.push('title_truncated');

  const rawDescription = cleanString(input.description, CHANNEL_LIMITS.etsy.descriptionMax);
  if (!rawDescription) corrections.push('description_empty');

  const tags = cleanTagList(input.tags, CHANNEL_LIMITS.etsy.tagsMax);
  const rawTags = Array.isArray(input.tags) ? input.tags.length : 0;
  if (rawTags > CHANNEL_LIMITS.etsy.tagsMax) corrections.push('tags_truncated');

  // Price range: dollars in the model, cents in the app.
  const rangeInput = (input.priceRange ?? input.price_range) as Record<string, unknown> | undefined;
  const lowRaw = rangeInput?.low ?? rangeInput?.min ?? rangeInput?.lowCents;
  const highRaw = rangeInput?.high ?? rangeInput?.max ?? rangeInput?.highCents;
  let lowCents = parseMoneyToCents(lowRaw);
  let highCents = parseMoneyToCents(highRaw);
  if (lowCents === null && highCents !== null) lowCents = highCents;
  if (highCents === null && lowCents !== null) highCents = lowCents;
  if (lowCents === null || highCents === null) {
    problems.push('price_missing');
    lowCents = 0;
    highCents = 0;
  } else {
    if (lowCents > highCents) {
      corrections.push('price_range_swapped');
      [lowCents, highCents] = [highCents, lowCents];
    }
    if (highCents > 10_000_00) {
      problems.push('price_implausible');
    }
  }

  const shipping: ShippingOption[] = [];
  const shippingInput = Array.isArray(input.shipping) ? input.shipping : [];
  for (const rawOption of shippingInput) {
    if (typeof rawOption !== 'object' || rawOption === null) continue;
    const option = rawOption as Record<string, unknown>;
    const label = cleanString(option.label ?? option.name, 80);
    if (!label) continue;
    const priceCents = parseMoneyToCents(option.price ?? option.priceCents ?? option.cost) ?? 0;
    const freeOver = option.freeOver ?? option.free_over ?? null;
    const freeOverCents = freeOver === null || freeOver === undefined ? null : parseMoneyToCents(freeOver);
    shipping.push({ label, priceCents, freeOverCents });
    if (shipping.length >= 5) break;
  }
  if (shipping.length === 0) corrections.push('shipping_missing');

  const originalRaw = input.originalOrVintage ?? input.original_or_vintage ?? null;
  const originalOrVintage =
    originalRaw === true || originalRaw === 'true' ? true : originalRaw === false || originalRaw === 'false' ? false : null;

  const condition = cleanString(input.condition, 40) || 'unspecified';

  const confidenceRaw = input.confidence;
  let confidence = typeof confidenceRaw === 'number' && Number.isFinite(confidenceRaw) ? confidenceRaw : 0.5;
  if (confidenceRaw !== undefined && typeof confidenceRaw !== 'number') confidence = 0.5;
  confidence = Math.min(1, Math.max(0, Math.round(confidence * 100) / 100));
  if (confidence < 0.5) corrections.push('low_confidence');

  const flags = cleanTagList(input.flags, 8);
  if (originalOrVintage === null) flags.push('original_or_vintage_unconfirmed');

  const proposal: NormalizedProposal = {
    title,
    description: rawDescription,
    tags,
    priceRange: { lowCents, highCents },
    shipping,
    originalOrVintage,
    condition,
    confidence,
    flags,
    corrections,
  };

  return { proposal, problems, corrections, usable: problems.length === 0 };
}

/** Build the stored draft from a reviewed proposal. */
export function makeDraft(input: {
  id: string;
  sellerId: string;
  proposal: NormalizedProposal;
  photos: string[];
  notes: string;
  now: string;
}): ListingDraft {
  return {
    id: input.id,
    sellerId: input.sellerId,
    status: 'draft',
    title: input.proposal.title,
    description: input.proposal.description,
    tags: input.proposal.tags,
    priceRange: input.proposal.priceRange,
    shipping: input.proposal.shipping,
    photos: input.photos,
    notes: input.notes,
    originalOrVintage: input.proposal.originalOrVintage,
    condition: input.proposal.condition,
    confidence: input.proposal.confidence,
    flags: input.proposal.flags,
    createdAt: input.now,
  };
}

// ── per-marketplace rendering ────────────────────────────────────────────────

export interface ChannelDraft {
  marketplace: Marketplace;
  title: string;
  description: string;
  tags: string[];
  priceCents: number;
  shipping: ShippingOption[];
  /** False when a human has to do something before this can be published. */
  ready: boolean;
  blockers: string[];
  /** Facebook only: the paste card. Absent for the channels we publish to. */
  card?: FacebookCard;
}

/**
 * Render one approved draft for one marketplace.
 *
 * The differences live here, not in the phone form: Etsy is original/vintage
 * only, eBay titles are short, Facebook gets a paste card with no tags.
 */
export function renderForMarketplace(
  draft: ListingDraft,
  marketplace: Marketplace,
  priceCents?: number,
): ChannelDraft {
  const limits = CHANNEL_LIMITS[marketplace];
  const price = priceCents ?? Math.round((draft.priceRange.lowCents + draft.priceRange.highCents) / 2);
  const blockers: string[] = [];

  if (draft.status !== 'approved') blockers.push('draft_not_approved');
  if (marketplace === 'etsy' && draft.originalOrVintage !== true) {
    blockers.push('etsy_requires_original_or_vintage');
  }
  if (price <= 0) blockers.push('price_missing');

  // Facebook is a paste card, not a listing: Emily copies the text herself.
  if (marketplace === 'facebook') {
    const card = renderFacebookCard({
      title: draft.title,
      description: draft.description,
      priceCents: price,
      condition: draft.condition,
      originalOrVintage: draft.originalOrVintage,
      photoCount: draft.photos.length,
    });
    return {
      marketplace,
      title: truncate(stripMarkup(draft.title), limits.titleMax),
      description: truncate(draft.description, limits.descriptionMax),
      tags: [],
      priceCents: price,
      shipping: draft.shipping,
      ready: blockers.length === 0 && card.ready,
      blockers: [...new Set([...blockers, ...card.blockers])],
      card,
    };
  }

  const title = truncate(draft.title, limits.titleMax);
  return {
    marketplace,
    title,
    description: truncate(draft.description, limits.descriptionMax),
    tags: limits.tagsMax === 0 ? [] : draft.tags.slice(0, limits.tagsMax),
    priceCents: price,
    shipping: draft.shipping,
    ready: blockers.length === 0,
    blockers,
  };
}

/** Which marketplaces this draft may go to, and why not when it may not. */
export function eligibleMarketplaces(draft: ListingDraft): { marketplace: Marketplace; eligible: boolean; reason?: string }[] {
  return (['ebay', 'etsy', 'facebook'] as Marketplace[]).map((marketplace) => {
    if (marketplace === 'etsy' && draft.originalOrVintage !== true) {
      return { marketplace, eligible: false, reason: 'original_or_vintage_not_confirmed' };
    }
    return { marketplace, eligible: true };
  });
}

// ── Emily's decision ─────────────────────────────────────────────────────────

export interface ApprovalInput {
  /** The price she settled on, in cents. Defaults to the middle of the range. */
  priceCents?: number;
  title?: string;
  description?: string;
  tags?: string[];
}

export interface ApprovalOutcome {
  draft: ListingDraft;
  item: {
    title: string;
    description: string;
    priceCents: number;
    tags: string[];
    photos: string[];
    /**
     * The facts travel with the item. The Facebook card is rendered from the
     * item record, and Etsy is original/vintage only — a card that guessed
     * would be a card that lied.
     */
    condition: string;
    originalOrVintage: boolean | null;
  };
}

/**
 * Approve a draft. The result is a canonical item record — the thing every
 * marketplace listing will be projected from later.
 */
export function approveDraft(draft: ListingDraft, input: ApprovalInput, now: string): ApprovalOutcome {
  if (draft.status !== 'draft') {
    throw new Error(`draft ${draft.id} is ${draft.status}; only a draft can be approved`);
  }
  const range = draft.priceRange;
  const fallback = Math.round((range.lowCents + range.highCents) / 2);
  const priceCents = Math.round(input.priceCents ?? fallback);
  if (!Number.isFinite(priceCents) || priceCents < 0) {
    throw new Error('price must be a non-negative number of cents');
  }
  if (range.lowCents > 0 && (priceCents < range.lowCents || priceCents > range.highCents)) {
    throw new Error(`price ${priceCents} is outside the drafted range ${range.lowCents}-${range.highCents}`);
  }

  const decided: ListingDraft = {
    ...draft,
    status: 'approved',
    decidedAt: now,
    title: cleanString(input.title ?? draft.title, CHANNEL_LIMITS.etsy.titleMax),
    description: cleanString(input.description ?? draft.description, CHANNEL_LIMITS.etsy.descriptionMax),
    tags: input.tags ? cleanTagList(input.tags, CHANNEL_LIMITS.etsy.tagsMax) : draft.tags,
  };

  return {
    draft: decided,
    item: {
      title: decided.title,
      description: decided.description,
      priceCents,
      tags: decided.tags,
      photos: decided.photos,
      condition: decided.condition,
      originalOrVintage: decided.originalOrVintage,
    },
  };
}

export function rejectDraft(draft: ListingDraft, now: string): ListingDraft {
  if (draft.status !== 'draft') {
    throw new Error(`draft ${draft.id} is ${draft.status}; only a draft can be rejected`);
  }
  return { ...draft, status: 'rejected', decidedAt: now };
}
