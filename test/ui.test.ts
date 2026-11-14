import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp, listen } from '../src/server.ts';
import { MemoryRemoteActionStore } from '../src/etsy-store.ts';

test('the shell redirects to sign-in without a session and renders the Today screen with one', async () => {
  const sessions: Record<string, { authUserId: string; displayName: string }> = {
    'emily-token': { authUserId: 'auth-emily', displayName: 'Emily' },
  };
  const { server } = createApp({ verifySession: (t) => (t ? sessions[t] ?? null : null) });
  const { port, close } = await listen(server);
  const base = `http://127.0.0.1:${port}`;

  const anonymous = await fetch(base, { redirect: 'manual' });
  assert.equal(anonymous.status, 302);
  assert.equal(anonymous.headers.get('location'), '/auth/login');

  const cookie = 'stoop_session=emily-token';
  await fetch(`${base}/api/items`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ title: 'Print no. 3', priceCents: 3500 }),
  });

  const page = await fetch(base, { headers: { cookie } });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<title>Stoop<\/title>/);
  assert.match(html, /viewport/);
  assert.match(html, /Print no\. 3/);
  assert.match(html, /\$35\.00/);

  await close();
});

test('a listing that could not be ended is on the screen, not just in a queue', async () => {
  const sessions: Record<string, { authUserId: string; displayName: string }> = {
    'emily-token': { authUserId: 'auth-emily', displayName: 'Emily' },
  };
  const remoteActions = new MemoryRemoteActionStore();
  await remoteActions.enqueue({
    marketplace: 'ebay',
    action: 'delist',
    remoteId: 'offer-1',
    state: 'needs_human',
    needsHuman: true,
    lastError: 'there is no ebay adapter yet; the listing has to be ended by hand',
  });
  const { server } = createApp({
    verifySession: (t) => (t ? sessions[t] ?? null : null),
    remoteActions,
  });
  const { port, close } = await listen(server);
  const base = `http://127.0.0.1:${port}`;
  const cookie = 'stoop_session=emily-token';

  const page = await fetch(base, { headers: { cookie } });
  const html = await page.text();
  assert.match(html, /Needs you/);
  assert.match(html, /ebay listing still needs to be ended by hand/);

  const today = await fetch(`${base}/api/today`, { headers: { cookie } });
  const body = (await today.json()) as { actions: { marketplace: string; needsHuman: boolean }[] };
  assert.equal(body.actions.length, 1);
  assert.equal(body.actions[0].marketplace, 'ebay');

  await close();
});
