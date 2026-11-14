import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp, listen } from '../src/server.ts';

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
