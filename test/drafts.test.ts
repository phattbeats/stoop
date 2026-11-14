import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, listen, type Session } from '../src/server.ts';
import { MemoryDraftStore } from '../src/drafts.ts';

const proposal = {
  title: 'Screen-printed bird study',
  description: 'Screen print on cream paper. Signed lower right.',
  tags: ['screen print', 'bird'],
  priceRange: { low: 18, high: 24 },
  shipping: [{ label: 'USPS Ground Advantage', price: 6.5 }],
  originalOrVintage: true,
  condition: 'good',
  confidence: 0.8,
};

async function withServer(
  run: (ctx: {
    base: string;
    close: () => Promise<void>;
    cookie: string;
    photosDir: string;
    calls: { notes: string; photos: number }[];
  }) => Promise<void>,
): Promise<void> {
  const sessions: Record<string, Session> = {
    'emily-token': { authUserId: 'auth-emily', displayName: 'Emily' },
    'other-token': { authUserId: 'auth-other', displayName: 'Someone Else' },
  };
  const photosDir = await mkdtemp(join(tmpdir(), 'stoop-photos-'));
  await writeFile(join(photosDir, 'bird.jpg'), 'not-really-a-jpeg');
  const calls: { notes: string; photos: number }[] = [];

  const { server } = createApp({
    verifySession: (token) => (token ? sessions[token] ?? null : null),
    drafts: new MemoryDraftStore(),
    photosDir,
    drafter: {
      propose: async (request) => {
        calls.push({ notes: request.notes, photos: request.photos.length });
        return proposal;
      },
    },
  });
  const { port, close } = await listen(server);
  await run({ base: `http://127.0.0.1:${port}`, close, cookie: 'stoop_session=emily-token', photosDir, calls });
}

test('the drafter refuses to serve without a PHATT ID session', async () => {
  await withServer(async ({ base, close }) => {
    const res = await fetch(`${base}/api/drafts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ photos: ['bird.jpg'] }),
    });
    assert.equal(res.status, 401);
    await close();
  });
});

test('photograph it, the model proposes, Emily approves, the item exists', async () => {
  await withServer(async ({ base, close, cookie, calls }) => {
    const drafted = await fetch(`${base}/api/drafts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        photos: ['bird.jpg'],
        notes: 'voice note: bird print, small, in a frame',
        hints: ['signed'],
        marketplaces: ['ebay', 'etsy'],
      }),
    });
    assert.equal(drafted.status, 201);
    const body = (await drafted.json()) as {
      draft: { id: string; title: string; status: string; priceRange: { lowCents: number; highCents: number } };
      marketplaces: { marketplace: string; eligible: boolean }[];
    };
    assert.equal(body.draft.status, 'draft');
    assert.equal(body.draft.title, 'Screen-printed bird study');
    assert.equal(body.draft.priceRange.lowCents, 1800);
    assert.equal(body.marketplaces.find((m) => m.marketplace === 'etsy')?.eligible, true);
    // The photo was read off the box and handed to the model as an image.
    assert.equal(calls[0].photos, 1);
    assert.equal(calls[0].notes, 'voice note: bird print, small, in a frame');

    const pending = await fetch(`${base}/api/drafts`, { headers: { cookie } });
    const list = (await pending.json()) as { drafts: { id: string }[] };
    assert.equal(list.drafts.length, 1);

    const approved = await fetch(`${base}/api/drafts/${body.draft.id}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ priceCents: 2200 }),
    });
    assert.equal(approved.status, 200);
    const result = (await approved.json()) as {
      draft: { status: string; itemId?: string };
      item: { id: string; title: string; priceCents: number; status: string };
    };
    assert.equal(result.draft.status, 'approved');
    assert.equal(result.item.priceCents, 2200);
    assert.equal(result.item.status, 'draft');

    const today = await fetch(`${base}/api/today`, { headers: { cookie } });
    const items = (await today.json()) as { items: { id: string; title: string }[] };
    assert.equal(items.items.length, 1);
    assert.equal(items.items[0].id, result.item.id);

    await close();
  });
});

test('a rejected draft creates nothing', async () => {
  await withServer(async ({ base, close, cookie }) => {
    const drafted = await fetch(`${base}/api/drafts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ photos: ['bird.jpg'] }),
    });
    const { draft } = (await drafted.json()) as { draft: { id: string } };

    const rejected = await fetch(`${base}/api/drafts/${draft.id}/reject`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({}),
    });
    assert.equal(rejected.status, 200);
    assert.equal(((await rejected.json()) as { draft: { status: string } }).draft.status, 'rejected');

    const today = await fetch(`${base}/api/today`, { headers: { cookie } });
    const items = (await today.json()) as { items: unknown[] };
    assert.equal(items.items.length, 0);
    await close();
  });
});

test('one seller cannot read or approve another seller\'s draft', async () => {
  await withServer(async ({ base, close, cookie }) => {
    const drafted = await fetch(`${base}/api/drafts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ photos: ['bird.jpg'] }),
    });
    const { draft } = (await drafted.json()) as { draft: { id: string } };

    const otherCookie = 'stoop_session=other-token';
    const theirs = await fetch(`${base}/api/drafts`, { headers: { cookie: otherCookie } });
    assert.equal(((await theirs.json()) as { drafts: unknown[] }).drafts.length, 0);

    const stolen = await fetch(`${base}/api/drafts/${draft.id}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: otherCookie },
      body: JSON.stringify({ priceCents: 100 }),
    });
    assert.equal(stolen.status, 404);
    await close();
  });
});

test('a photo path outside the photos directory is refused', async () => {
  await withServer(async ({ base, close, cookie }) => {
    const res = await fetch(`${base}/api/drafts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ photos: ['../../etc/passwd'] }),
    });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error: string }).error, 'bad_request');
    await close();
  });
});

test('a draft with no photos is refused: the drafter is a vision path', async () => {
  await withServer(async ({ base, close, cookie }) => {
    const res = await fetch(`${base}/api/drafts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ notes: 'just words' }),
    });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error: string }).error, 'photos_required');
    await close();
  });
});

test('Emily photographs it from her phone: the upload is drafted and waits for her', async () => {
  await withServer(async ({ base, close, cookie, photosDir, calls }) => {
    const form = new FormData();
    form.set('photo', new File([new Uint8Array([1, 2, 3])], 'bird.jpg', { type: 'image/jpeg' }));
    form.set('notes', 'bird print, framed');
    form.set('marketplaces', 'ebay,etsy');

    const drafted = await fetch(`${base}/api/drafts`, { method: 'POST', headers: { cookie }, body: form });
    assert.equal(drafted.status, 201);
    assert.equal(calls[0].photos, 1);
    assert.equal(calls[0].notes, 'bird print, framed');

    const { draft } = (await drafted.json()) as { draft: { id: string; title: string } };

    // The photo landed in the photos directory under a name we chose.
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(photosDir);
    const uploaded = files.filter((name) => /^[0-9a-f-]{36}\.jpg$/.test(name));
    assert.equal(uploaded.length, 1);
    assert.ok(files.includes('bird.jpg'));

    // And it is on the Today screen, waiting on her.
    const page = await fetch(base, { headers: { cookie } });
    const html = await page.text();
    assert.match(html, /Waiting on you/);
    assert.match(html, /Screen-printed bird study/);
    assert.match(html, /\$18\.00/);

    await close();
  });
});
