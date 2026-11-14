import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  computeSignature,
  isOrderPaid,
  parseEtsyEvent,
  signingKeyBytes,
  verifyEtsyWebhook,
  EtsyWebhookError,
} from '../src/etsy-webhook.ts';

const SECRET = 'whsec_c2VjcmV0LWtleS1mb3ItdGhlLXRlc3RzLTExMjM0NTY3OA==';

function delivery(body: unknown, options: { id?: string; timestamp?: number; secret?: string } = {}) {
  const raw = Buffer.from(JSON.stringify(body), 'utf8');
  const id = options.id ?? 'wh_123';
  const timestamp = options.timestamp ?? 1_700_000_000;
  const secret = options.secret ?? SECRET;
  return {
    raw,
    headers: {
      id,
      timestamp: String(timestamp),
      signature: computeSignature(secret, id, timestamp, raw),
    },
  };
}

test('the signing key is the base64 secret without its prefix', () => {
  const key = signingKeyBytes(SECRET);
  assert.equal(key.toString('utf8'), Buffer.from(SECRET.replace('whsec_', ''), 'base64').toString('utf8'));
  assert.ok(key.toString('utf8').startsWith('secret-key-for-the-tests-'));
});

test('a genuine delivery verifies', () => {
  const { raw, headers } = delivery({ event_type: 'order.paid' });
  const verified = verifyEtsyWebhook(raw, headers, { secret: SECRET, now: () => 1_700_000_000_000 });
  assert.equal(verified.eventId, 'wh_123');
  assert.equal(verified.timestamp, 1_700_000_000);
});

test('a forged signature is refused before the body is even read', () => {
  const { raw } = delivery({ event_type: 'order.paid' });
  const headers = { id: 'wh_123', timestamp: '1700000000', signature: 'not-the-signature' };
  assert.throws(
    () => verifyEtsyWebhook(raw, headers, { secret: SECRET, now: () => 1_700_000_000_000 }),
    (error: unknown) => error instanceof EtsyWebhookError && error.reason === 'bad_signature',
  );
});

test('a signature over a different body does not verify', () => {
  const signed = delivery({ event_type: 'order.paid' });
  const tampered = Buffer.from(JSON.stringify({ event_type: 'order.paid', shop_id: 999 }), 'utf8');
  assert.throws(
    () => verifyEtsyWebhook(tampered, signed.headers, { secret: SECRET, now: () => 1_700_000_000_000 }),
    (error: unknown) => error instanceof EtsyWebhookError && error.reason === 'bad_signature',
  );
});

test('a replayed delivery outside the window is refused', () => {
  const { raw, headers } = delivery({ event_type: 'order.paid' }, { timestamp: 1_700_000_000 });
  assert.throws(
    () => verifyEtsyWebhook(raw, headers, { secret: SECRET, now: () => 1_700_001_000_000 }),
    (error: unknown) => error instanceof EtsyWebhookError && error.reason === 'stale_timestamp',
  );
});

test('a delivery inside the window is accepted', () => {
  const { raw, headers } = delivery({ event_type: 'order.paid' }, { timestamp: 1_700_000_000 });
  const verified = verifyEtsyWebhook(raw, headers, { secret: SECRET, now: () => 1_700_000_100_000 });
  assert.equal(verified.eventId, 'wh_123');
});

test('missing headers are refused', () => {
  const { raw } = delivery({ event_type: 'order.paid' });
  assert.throws(
    () => verifyEtsyWebhook(raw, { id: 'wh_123' }, { secret: SECRET }),
    (error: unknown) => error instanceof EtsyWebhookError && error.reason === 'missing_headers',
  );
});

test('the event carries the id, the shop and the receipt url', () => {
  const { raw, headers } = delivery({
    event_type: 'order.paid',
    shop_id: 42,
    resource_url: 'https://openapi.etsy.com/v3/application/shops/42/receipts/7',
  });
  const verified = verifyEtsyWebhook(raw, headers, { secret: SECRET, now: () => 1_700_000_000_000 });
  const event = parseEtsyEvent(raw, verified.eventId, verified.timestamp);
  assert.equal(event.eventType, 'order.paid');
  assert.equal(event.shopId, '42');
  assert.equal(event.resourceUrl, 'https://openapi.etsy.com/v3/application/shops/42/receipts/7');
  assert.ok(isOrderPaid(event));
});

test('a body that is not JSON is refused', () => {
  const raw = Buffer.from('not json', 'utf8');
  assert.throws(
    () => parseEtsyEvent(raw, 'wh_123', 1_700_000_000),
    (error: unknown) => error instanceof EtsyWebhookError && error.reason === 'malformed_body',
  );
});
