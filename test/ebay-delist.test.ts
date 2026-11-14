/**
 * Ending an eBay offer for real.
 *
 * When a print sells on Facebook, the eBay offer has to end — otherwise it
 * is still buyable and she has sold the same thing twice. That is a
 * DELETE against the Sell Inventory API, and it is the call that has to
 * survive the failure cases.
 *
 * What is tested here is the remote half, which the ledger tests do not
 * reach: the method and the path, a 404 that means the offer is already
 * gone, and a failure that leaves the work for a human instead of pretending
 * it ended.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EBayAdapter } from '../src/ebay.ts';
import { EBayClient } from '../src/ebay-client.ts';
import { DelistRunner } from '../src/sync.ts';
import { MemoryRemoteActionStore } from '../src/etsy-store.ts';

function fakeFetch(
  handler: (call: { url: string; method: string }) => { status?: number; body?: unknown },
) {
  const calls: { url: string; method: string }[] = [];
  const impl = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET' });
    const result = handler(calls[calls.length - 1]);
    const status = result.status ?? 200;
    // A 204 carries no body, and a Response with a body and a null-body
    // status is a TypeError — which is not what eBay does.
    const body = status === 204 || status === 205 ? null : JSON.stringify(result.body ?? {});
    return new Response(body, {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function build(handler: (call: { url: string; method: string }) => { status?: number; body?: unknown }) {
  const { impl, calls } = fakeFetch(handler);
  const client = new EBayClient({
    clientId: 'AppId',
    clientSecret: 'CertId',
    environment: 'sandbox',
    fetchImpl: impl,
  });
  const adapter = new EBayAdapter(client, { accessToken: async () => 'seller-token' }, {
    inventoryLocationId: 'inv-location-1',
    categoryId: '183050',
    fulfillmentPolicyId: 'ful-1',
    paymentPolicyId: 'pay-1',
    returnPolicyId: 'ret-1',
  });
  const queue = new MemoryRemoteActionStore();
  const delist = new DelistRunner(queue, { ebay: adapter });
  return { adapter, delist, queue, calls };
}

test('ending an offer is a DELETE against the offer, not a POST', async () => {
  const { adapter, calls } = build(() => ({ status: 204 }));

  const result = await adapter.end('offer-99');

  assert.equal(result.ended, true);
  const call = calls.find((c) => c.url.includes('/offer/'));
  assert.ok(call, 'the offer is called');
  assert.equal(call!.method, 'DELETE');
  assert.match(call!.url, /\/sell\/inventory\/v1\/offer\/offer-99$/);
});

test('an offer that is already gone is ended, not failed', async () => {
  const { adapter } = build(() => ({ status: 404, body: { errors: [{ message: 'not found' }] } }));

  const result = await adapter.end('offer-99');

  assert.equal(result.ended, true);
  assert.equal(result.alreadyGone, true);
});

test('an offer that was already ended is ended, not failed', async () => {
  const { adapter } = build(() => ({ status: 410, body: { errors: [] } }));

  const result = await adapter.end('offer-99');

  assert.equal(result.ended, true);
  assert.equal(result.alreadyGone, true);
});

test('a failure is left for a human rather than swallowed', async () => {
  const { adapter } = build(() => ({ status: 500, body: { errors: [{ message: 'boom' }] } }));

  await assert.rejects(() => adapter.end('offer-99'));
});

test('the delist runner ends the eBay offer when the print sells elsewhere', async () => {
  const { delist, calls } = build(() => ({ status: 204 }));

  const outcome = await delist.delist([
    { listingId: 'l1', itemId: 'i1', marketplace: 'ebay', remoteId: 'offer-99' },
  ]);

  assert.equal(outcome.succeeded, 1);
  assert.equal(outcome.needsHuman, 0);
  const call = calls.find((c) => c.url.includes('/offer/'));
  assert.equal(call?.method, 'DELETE');
});

test('a failed eBay delist becomes work for a human, not a silent no-op', async () => {
  const { delist, queue } = build(() => ({ status: 500, body: { errors: [{ message: 'boom' }] } }));

  const outcome = await delist.delist([
    { listingId: 'l1', itemId: 'i1', marketplace: 'ebay', remoteId: 'offer-99' },
  ]);

  assert.equal(outcome.succeeded, 0);
  assert.equal(outcome.failed, 1);
  assert.equal(outcome.needsHuman, 1);

  const open = await queue.listOpen();
  const failed = open.find((a) => a.remoteId === 'offer-99');
  assert.equal(failed?.state, 'needs_human');
  assert.equal(failed?.needsHuman, true);
});

test('an offer that was already gone counts as ended, with no work for a human', async () => {
  const { delist, queue } = build(() => ({ status: 404, body: { errors: [] } }));

  const outcome = await delist.delist([
    { listingId: 'l1', itemId: 'i1', marketplace: 'ebay', remoteId: 'offer-99' },
  ]);

  assert.equal(outcome.succeeded, 1);
  assert.equal(outcome.needsHuman, 0);
  const open = await queue.listOpen();
  assert.equal(open.length, 0, 'nothing is left on the list');
});
