/**
 * Stoop — Etsy's webhook signature, replay window and event shape.
 *
 * Etsy's documented scheme:
 *   signed_content = webhook-id + "." + webhook-timestamp + "." + raw_body
 *   secret_bytes   = base64_decode(secret without its "whsec_" prefix)
 *   signature      = base64(HMAC-SHA256(secret_bytes, signed_content))
 *
 * and the header may carry more than one signature, so any of them may match.
 *
 * The order of authority, which is the whole point of this file:
 *   1. verify the signature, over the RAW bytes, before anything is parsed;
 *   2. reject a stale timestamp, so a captured request cannot be replayed;
 *   3. treat the webhook id as the idempotency key, because Etsy retries.
 *
 * Only after all three does a caller get to look at the payload.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export const DEFAULT_TOLERANCE_SECONDS = 300;

export type EtsyWebhookFailure =
  | 'missing_headers'
  | 'bad_signature'
  | 'stale_timestamp'
  | 'malformed_body';

export class EtsyWebhookError extends Error {
  readonly reason: EtsyWebhookFailure;

  constructor(reason: EtsyWebhookFailure, message: string) {
    super(message);
    this.name = 'EtsyWebhookError';
    this.reason = reason;
  }
}

export interface EtsyWebhookHeaders {
  /** `webhook-id` — unique per call, and the same on retries. */
  id?: string;
  /** `webhook-timestamp` — unix seconds. */
  timestamp?: string;
  /** `webhook-signature` — base64 HMAC-SHA256, possibly several. */
  signature?: string;
}

export interface EtsyWebhookEvent {
  /** The webhook id: the idempotency key. */
  eventId: string;
  eventType: string;
  shopId?: string;
  /** Where the receipt is. Only Etsy's own hosts are ever fetched. */
  resourceUrl?: string;
  occurredAt: string;
  payload: Record<string, unknown>;
}

/**
 * The signing key.
 *
 * Etsy hands out a "whsec_"-prefixed base64 secret. Older/other portals hand
 * out a plain secret, so a plain one is used verbatim rather than failing the
 * signature of a perfectly good delivery.
 */
export function signingKeyBytes(secret: string): Buffer {
  const trimmed = secret.trim();
  const withoutPrefix = trimmed.startsWith('whsec_') ? trimmed.slice('whsec_'.length) : trimmed;
  if (!withoutPrefix) throw new EtsyWebhookError('bad_signature', 'the signing secret is empty');
  const decoded = Buffer.from(withoutPrefix, 'base64');
  if (decoded.length > 0 && decoded.toString('base64').replace(/=+$/, '') === withoutPrefix.replace(/=+$/, '')) {
    return decoded;
  }
  return Buffer.from(withoutPrefix, 'utf8');
}

/** The signature Etsy would send for this delivery. Also what the tests sign with. */
export function computeSignature(
  secret: string,
  eventId: string,
  timestamp: number,
  rawBody: Buffer | string,
): string {
  const body = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  const signedContent = `${eventId}.${timestamp}.${body}`;
  return createHmac('sha256', signingKeyBytes(secret)).update(signedContent).digest('base64');
}

/**
 * Verify a delivery.
 *
 * Returns the event id and the timestamp once the request is proven genuine
 * and fresh. Throws otherwise, with the reason.
 */
export function verifyEtsyWebhook(
  rawBody: Buffer,
  headers: EtsyWebhookHeaders,
  options: { secret: string; now?: () => number; toleranceSeconds?: number },
): { eventId: string; timestamp: number } {
  const eventId = headers.id?.trim();
  const timestampRaw = headers.timestamp?.trim();
  const signatureHeader = headers.signature?.trim();
  if (!eventId || !timestampRaw || !signatureHeader) {
    throw new EtsyWebhookError('missing_headers', 'the delivery is missing one of webhook-id, webhook-timestamp, webhook-signature');
  }

  const timestamp = Number(timestampRaw);
  if (!Number.isFinite(timestamp)) {
    throw new EtsyWebhookError('missing_headers', 'webhook-timestamp is not a unix timestamp');
  }

  const provided = signatureHeader
    .split(/\s+/)
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => Buffer.from(value, 'base64'));
  const expected = Buffer.from(computeSignature(options.secret, eventId, timestamp, rawBody), 'base64');
  const matched = provided.some(
    (candidate) => candidate.length === expected.length && timingSafeEqual(candidate, expected),
  );
  if (!matched) {
    throw new EtsyWebhookError('bad_signature', 'the delivery signature does not match');
  }

  const now = options.now ? options.now() : Date.now();
  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (Math.abs(Math.floor(now / 1000) - timestamp) > tolerance) {
    throw new EtsyWebhookError('stale_timestamp', 'the delivery timestamp is outside the replay window');
  }

  return { eventId, timestamp };
}

/** Parse the body of a delivery that has already been verified. */
export function parseEtsyEvent(rawBody: Buffer, eventId: string, timestamp: number): EtsyWebhookEvent {
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw new EtsyWebhookError('malformed_body', 'the delivery body is not JSON');
  }
  if (!payload || typeof payload !== 'object') {
    throw new EtsyWebhookError('malformed_body', 'the delivery body is not an object');
  }
  const body = payload as Record<string, unknown>;
  const eventType = typeof body.event_type === 'string' ? body.event_type : '';
  if (!eventType) {
    throw new EtsyWebhookError('malformed_body', 'the delivery names no event_type');
  }
  const event: EtsyWebhookEvent = {
    eventId,
    eventType,
    occurredAt: new Date(timestamp * 1000).toISOString(),
    payload: body,
  };
  if (body.shop_id !== undefined) event.shopId = String(body.shop_id);
  if (typeof body.resource_url === 'string') event.resourceUrl = body.resource_url;
  return event;
}

/** The only order event that moves stock. */
export function isOrderPaid(event: EtsyWebhookEvent): boolean {
  return event.eventType === 'order.paid';
}
