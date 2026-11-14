import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderFacebookCard, usableCondition } from '../src/facebook.ts';

const facts = {
  title: 'Print no. 3 — screen-printed bird study',
  description: 'Screen print on cream paper. Signed lower right.',
  priceCents: 3500,
  condition: 'good',
  originalOrVintage: true as boolean | null,
  photoCount: 3,
};

test('the card carries what a buyer needs: title, price, condition, description', () => {
  const card = renderFacebookCard(facts);
  assert.equal(card.ready, true);
  assert.deepEqual(card.blockers, []);
  assert.match(card.text, /^Print no\. 3 — screen-printed bird study$/m);
  assert.match(card.text, /\$35\.00/);
  assert.match(card.text, /^Condition: good$/m);
  assert.match(card.text, /Screen print on cream paper\. Signed lower right\./);
});

test('the card carries no tags: Facebook has no tag field', () => {
  const card = renderFacebookCard(facts);
  assert.equal(card.text.includes('#'), false);
  assert.equal(card.text.toLowerCase().includes('tags'), false);
});

test('the card says what the item actually is, and never rounds it up', () => {
  const original = renderFacebookCard({ ...facts, originalOrVintage: true });
  assert.match(original.text, /^Original or vintage: yes$/m);

  const notOriginal = renderFacebookCard({ ...facts, originalOrVintage: false });
  assert.match(notOriginal.text, /^Original or vintage: no$/m);
  assert.equal(notOriginal.text.includes('vintage: yes'), false);
});

test('an item with no originality on record gets no originality claim', () => {
  const unknown = renderFacebookCard({ ...facts, originalOrVintage: null });
  assert.equal(unknown.text.includes('Original or vintage'), false);
  assert.ok(
    unknown.notes.some((note) => /original or vintage is not recorded/i.test(note)),
    'Emily is told the card is staying quiet on purpose',
  );
});

test('the photos are on her phone, and the card does not pretend otherwise', () => {
  const card = renderFacebookCard(facts);
  assert.match(card.photoNote, /3 photos from your phone/);
  assert.match(card.photoNote, /does not host them/i);
  // The photo instruction is for Emily, not for the buyer: it is not pasted.
  assert.equal(card.text.includes('phone'), false);
  assert.equal(card.text.includes('host'), false);
});

test('no condition on the record means the card is not ready, and it guesses nothing', () => {
  const card = renderFacebookCard({ ...facts, condition: 'unspecified' });
  assert.equal(card.ready, false);
  assert.ok(card.blockers.includes('condition_missing'));
  assert.equal(card.text.includes('Condition:'), false);
  assert.equal(usableCondition('unspecified'), null);
  assert.equal(usableCondition('like new'), 'like new');
  assert.equal(usableCondition(''), null);
});

test('a card with no price is not ready', () => {
  const card = renderFacebookCard({ ...facts, priceCents: 0 });
  assert.equal(card.ready, false);
  assert.ok(card.blockers.includes('price_missing'));
});

test('the card is a Facebook card: short title, no markup, bounded description', () => {
  const card = renderFacebookCard({
    ...facts,
    title: `<b>${'x'.repeat(200)}</b>`,
    description: 'y'.repeat(5000),
  });
  assert.equal(card.text.split('\n')[0].startsWith('<'), false);
  assert.equal(card.text.split('\n')[0].length, 100);
  assert.equal(card.text.includes('y'.repeat(1999)), true);
  assert.equal(card.text.includes('y'.repeat(2000)), false);
  assert.equal(card.text.endsWith('…'), true);
});
