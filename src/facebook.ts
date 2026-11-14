/**
 * Stoop — the Facebook paste card.
 *
 * Facebook is not a channel Stoop can write to. No browser automation, no
 * login, no scraping, no posting on Emily's behalf, ever. It is a *paste
 * card*: this module turns one canonical item into the text she copies into
 * Facebook Marketplace, and into the two things she has to do herself —
 * attach the photos, and (when she says so) mark it posted.
 *
 * The honesty rules are the product here:
 *
 *   - Facebook has no tag field, so the card carries no tags.
 *   - The condition comes from the item record. If there is none, the card is
 *     not ready: we do not invent a condition for a buyer.
 *   - Original/vintage is asserted only when the item record asserts it. A
 *     "made by someone else" item is never rounded up to "vintage"; Etsy
 *     enforces the same rule per item at write time, and the card has to
 *     agree with it.
 *   - The photos live on Emily's phone. Stoop does not host them for
 *     Facebook, and nothing here pretends otherwise.
 *
 * The card is text, and a paste card is not inventory until she says it is
 * posted. That state lives on the listing (src/ledger.ts), not here.
 */

export const FACEBOOK_TITLE_MAX = 100;
export const FACEBOOK_DESCRIPTION_MAX = 2000;

/** What a card needs to know about the item it is for. */
export interface CardFacts {
  title: string;
  description?: string;
  priceCents: number;
  /** The item's condition. Empty/undefined/'unspecified' means unknown. */
  condition?: string | null;
  /**
   * true  — the item record asserts original or vintage;
   * false — it asserts it is not;
   * null  — not asserted either way. The card stays quiet and Emily is told.
   */
  originalOrVintage?: boolean | null;
  /** How many photos she has on her phone to attach. */
  photoCount?: number;
}

export interface FacebookCard {
  /** Exactly what she pastes into Facebook Marketplace. Nothing else. */
  text: string;
  /** The photos she has to attach herself. Never part of `text`. */
  photoNote: string;
  /** Told to Emily, never pasted. */
  notes: string[];
  /** False when a human has to do something before this can be posted. */
  ready: boolean;
  blockers: string[];
}

const KNOWN_CONDITIONS = new Set([
  'new',
  'like new',
  'likenew',
  'used',
  'good',
  'fair',
  'poor',
  'for parts',
  'unspecified',
]);

function cleanLine(value: string): string {
  return value.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * A condition we can put in front of a buyer.
 *
 * 'unspecified' is the model's shrug, not a condition: it is as good as
 * unknown, so the card is blocked until Emily says what it is.
 */
export function usableCondition(condition: string | null | undefined): string | null {
  const cleaned = cleanLine(condition ?? '');
  if (!cleaned) return null;
  if (!KNOWN_CONDITIONS.has(cleaned.toLowerCase())) return null;
  if (cleaned.toLowerCase() === 'unspecified') return null;
  return cleaned;
}

/**
 * Render the Facebook card for one item.
 *
 * The buyer-facing text is deliberately plain — a title, a price, a condition,
 * what it actually is, and the description. Everything that is for Emily and
 * not for the buyer (attach your photos, unconfirmed facts) is kept out of it.
 */
export function renderFacebookCard(facts: CardFacts): FacebookCard {
  const notes: string[] = [];
  const blockers: string[] = [];

  const title = truncate(cleanLine(facts.title ?? ''), FACEBOOK_TITLE_MAX);
  if (!title) blockers.push('title_missing');

  const description = truncate(
    cleanLine(facts.description ?? ''),
    FACEBOOK_DESCRIPTION_MAX,
  );

  const condition = usableCondition(facts.condition);
  if (!condition) {
    blockers.push('condition_missing');
    notes.push(
      'The condition is not recorded. Facebook buyers filter on it, and the card will not guess one.',
    );
  }

  if (!Number.isFinite(facts.priceCents) || facts.priceCents <= 0) {
    blockers.push('price_missing');
    notes.push('There is no price on this item yet, so there is no card to paste.');
  }

  const original = facts.originalOrVintage;
  if (original === null || original === undefined) {
    notes.push(
      'Original or vintage is not recorded for this item, so the card does not claim it. Etsy would refuse it.',
    );
  }

  const photoCount = Number.isFinite(facts.photoCount) ? Number(facts.photoCount) : 0;
  const photoNote =
    photoCount > 0
      ? `Attach ${photoCount} photo${photoCount === 1 ? '' : 's'} from your phone. Stoop does not host them for Facebook.`
      : 'Take the photos on your phone and attach them. Stoop does not host them for Facebook.';

  const lines: string[] = [];
  if (title) lines.push(title);
  if (Number.isFinite(facts.priceCents) && facts.priceCents > 0) lines.push(money(facts.priceCents));
  if (condition) lines.push(`Condition: ${condition}`);
  if (original === true) lines.push('Original or vintage: yes');
  if (original === false) lines.push('Original or vintage: no');
  if (description) {
    lines.push('');
    lines.push(description);
  }

  return {
    text: lines.join('\n'),
    photoNote,
    notes,
    ready: blockers.length === 0,
    blockers,
  };
}
