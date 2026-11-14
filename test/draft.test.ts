import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  approveDraft,
  eligibleMarketplaces,
  makeDraft,
  renderForMarketplace,
  rejectDraft,
  reviewProposal,
} from '../src/draft.ts';

const goodProposal = {
  title: 'Screen-printed bird study',
  description: 'Screen print on cream paper. Signed lower right.',
  tags: ['screen print', 'bird', 'wall art'],
  priceRange: { low: 18, high: 24 },
  shipping: [{ label: 'USPS Ground Advantage', price: 6.5 }],
  originalOrVintage: true,
  condition: 'good',
  confidence: 0.8,
  flags: [],
};

test('a usable proposal becomes a draft with prices in cents', () => {
  const review = reviewProposal(goodProposal);
  assert.equal(review.usable, true);
  assert.deepEqual(review.problems, []);
  assert.equal(review.proposal.priceRange.lowCents, 1800);
  assert.equal(review.proposal.priceRange.highCents, 2400);
  assert.equal(review.proposal.shipping[0].priceCents, 650);
  assert.equal(review.proposal.originalOrVintage, true);
});

test('a proposal with no price is refused, because a listing without a price is not a listing', () => {
  const review = reviewProposal({ ...goodProposal, priceRange: undefined });
  assert.equal(review.usable, false);
  assert.ok(review.problems.includes('price_missing'));
});

test('an over-long title and too many tags are clamped, not rejected', () => {
  const review = reviewProposal({
    ...goodProposal,
    title: 'x'.repeat(200),
    tags: Array.from({ length: 30 }, (_, i) => `tag${i}`),
  });
  assert.equal(review.usable, true);
  assert.equal(review.proposal.title.length, 80);
  assert.equal(review.proposal.tags.length, 13);
  assert.ok(review.corrections.includes('title_truncated'));
  assert.ok(review.corrections.includes('tags_truncated'));
});

test('a swapped price range is corrected, and an absurd one is refused', () => {
  const swapped = reviewProposal({ ...goodProposal, priceRange: { low: 40, high: 20 } });
  assert.equal(swapped.proposal.priceRange.lowCents, 2000);
  assert.equal(swapped.proposal.priceRange.highCents, 4000);
  assert.ok(swapped.corrections.includes('price_range_swapped'));

  const absurd = reviewProposal({ ...goodProposal, priceRange: { low: 50000, high: 90000 } });
  assert.equal(absurd.usable, false);
  assert.ok(absurd.problems.includes('price_implausible'));
});

test('Etsy is only offered for original or vintage items', () => {
  const original = makeDraft({
    id: 'draft_1',
    sellerId: 'seller_1',
    proposal: reviewProposal(goodProposal).proposal,
    photos: [],
    notes: '',
    now: '2026-11-14T00:00:00.000Z',
  });
  assert.equal(eligibleMarketplaces(original).find((m) => m.marketplace === 'etsy')?.eligible, true);

  const unknown = makeDraft({
    id: 'draft_2',
    sellerId: 'seller_1',
    proposal: reviewProposal({ ...goodProposal, originalOrVintage: null }).proposal,
    photos: [],
    notes: '',
    now: '2026-11-14T00:00:00.000Z',
  });
  const etsy = eligibleMarketplaces(unknown).find((m) => m.marketplace === 'etsy');
  assert.equal(etsy?.eligible, false);
  assert.equal(etsy?.reason, 'original_or_vintage_not_confirmed');
  assert.ok(unknown.flags.includes('original_or_vintage_unconfirmed'));
  assert.ok(renderForMarketplace(unknown, 'etsy').blockers.includes('etsy_requires_original_or_vintage'));
});

test('Facebook gets a paste card with no tags; eBay gets a short title', () => {
  const draft = makeDraft({
    id: 'draft_3',
    sellerId: 'seller_1',
    proposal: reviewProposal(goodProposal).proposal,
    photos: [],
    notes: '',
    now: '2026-11-14T00:00:00.000Z',
  });
  const fb = renderForMarketplace(draft, 'facebook');
  assert.deepEqual(fb.tags, []);
  assert.equal(fb.title.length <= 100, true);

  const ebay = renderForMarketplace(draft, 'ebay');
  assert.equal(ebay.title.length <= 80, true);
});

test('approving a draft yields a canonical item at the price Emily chose', () => {
  const draft = makeDraft({
    id: 'draft_4',
    sellerId: 'seller_1',
    proposal: reviewProposal(goodProposal).proposal,
    photos: ['/srv/appdata/stoop/photos/bird.jpg'],
    notes: 'voice note transcript',
    now: '2026-11-14T00:00:00.000Z',
  });
  const outcome = approveDraft(draft, { priceCents: 2200 }, '2026-11-14T01:00:00.000Z');
  assert.equal(outcome.draft.status, 'approved');
  assert.equal(outcome.item.priceCents, 2200);
  assert.equal(outcome.item.title, 'Screen-printed bird study');
  assert.deepEqual(outcome.item.photos, ['/srv/appdata/stoop/photos/bird.jpg']);
  assert.equal(renderForMarketplace(outcome.draft, 'ebay').ready, true);
});

test('approving at a price outside the drafted range is refused', () => {
  const draft = makeDraft({
    id: 'draft_5',
    sellerId: 'seller_1',
    proposal: reviewProposal(goodProposal).proposal,
    photos: [],
    notes: '',
    now: '2026-11-14T00:00:00.000Z',
  });
  assert.throws(() => approveDraft(draft, { priceCents: 99_00 }, '2026-11-14T01:00:00.000Z'), /outside the drafted range/);
});

test('a decided draft cannot be decided again', () => {
  const draft = makeDraft({
    id: 'draft_6',
    sellerId: 'seller_1',
    proposal: reviewProposal(goodProposal).proposal,
    photos: [],
    notes: '',
    now: '2026-11-14T00:00:00.000Z',
  });
  const rejected = rejectDraft(draft, '2026-11-14T01:00:00.000Z');
  assert.equal(rejected.status, 'rejected');
  assert.throws(() => approveDraft(rejected, {}, '2026-11-14T02:00:00.000Z'), /only a draft can be approved/);
});
