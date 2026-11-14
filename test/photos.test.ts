/**
 * The photos.
 *
 * Two callers need the same thing: the phone has to see Emily's print, and
 * eBay has to download it. So the photo needs to be reachable by URL from
 * the outside, and the URL has to be unguessable.
 *
 * What is tested here is the part that can be tested without a photo on
 * disk being a real picture: the naming rules, the traversal refusal, and
 * the fact that a photo which is not there is a 404 and not a 500.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp, listen, type Session } from '../src/server.ts';
import { absolutePhotoUrl, photoNameOf, photoPath, safePhotoName } from '../src/photos.ts';

const PHOTO_NAME = '0f8fad5b-d9cb-469f-a165-70867728950e.jpg';

async function withServer(
  photosDir: string,
  publicUrl: string,
  run: (ctx: { base: string; close: () => Promise<void>; cookie: string }) => Promise<void>,
): Promise<void> {
  const sessions: Record<string, Session> = {
    'emily-token': { authUserId: 'auth-emily', displayName: 'Emily' },
  };
  const { server } = createApp({
    verifySession: (token) => (token ? sessions[token] ?? null : null),
    photosDir,
    publicUrl,
  });
  const { port, close } = await listen(server);
  try {
    await run({ base: `http://127.0.0.1:${port}`, close, cookie: 'stoop_session=emily-token' });
  } finally {
    await close();
  }
}

test('a photo is served with its real content type', async () => {
  const dir = join(tmpdir(), `stoop-photos-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, PHOTO_NAME), Buffer.from([0xff, 0xd8, 0xff, 0xe0]));

  await withServer(dir, 'https://stoop.phatt.vip', async ({ base, close }) => {
    const res = await fetch(`${base}/media/${PHOTO_NAME}`);

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/jpeg');
    assert.match(res.headers.get('cache-control') ?? '', /immutable/);
    const bytes = new Uint8Array(await res.arrayBuffer());
    assert.equal(bytes.length, 4);
    await close();
  });
});

test('a photo that is not there is a 404, not a crash', async () => {
  const dir = join(tmpdir(), `stoop-photos-empty-${Date.now()}`);
  await mkdir(dir, { recursive: true });

  await withServer(dir, 'https://stoop.phatt.vip', async ({ base, close }) => {
    const res = await fetch(`${base}/media/nope.jpg`);
    assert.equal(res.status, 404);
    await close();
  });
});

test('a photo is served without a session, because eBay has none', async () => {
  const dir = join(tmpdir(), `stoop-photos-public-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, PHOTO_NAME), Buffer.from([0xff, 0xd8]));

  await withServer(dir, 'https://stoop.phatt.vip', async ({ base, close }) => {
    const res = await fetch(`${base}/media/${PHOTO_NAME}`);
    assert.equal(res.status, 200);
    await close();
  });
});

test('a path that tries to escape the photos directory is refused', async () => {
  const dir = join(tmpdir(), `stoop-photos-traversal-${Date.now()}`);
  await mkdir(dir, { recursive: true });

  await withServer(dir, 'https://stoop.phatt.vip', async ({ base, close }) => {
    for (const attempt of [
      '/media/..%2F..%2Fetc%2Fpasswd',
      '/media/../../etc/passwd',
      '/media/..',
      '/media/.env',
      '/media/secret.txt',
    ]) {
      const res = await fetch(`${base}${attempt}`);
      assert.ok(res.status === 404 || res.status === 400, `${attempt} should not be served`);
      const body = await res.text();
      assert.ok(!body.includes('root:'), `${attempt} must not leak a file`);
    }
    await close();
  });
});

test('only plain photo file names are accepted', () => {
  assert.equal(safePhotoName(PHOTO_NAME), PHOTO_NAME);
  assert.equal(safePhotoName('photo.PNG'), 'photo.PNG');
  assert.equal(safePhotoName('../../etc/passwd'), undefined);
  assert.equal(safePhotoName('a/b.jpg'), undefined);
  assert.equal(safePhotoName('noextension'), undefined);
  assert.equal(safePhotoName('x.exe'), undefined);
  assert.equal(safePhotoName(''), undefined);
});

test('a reference in any shape resolves to the served path', () => {
  assert.equal(photoPath(PHOTO_NAME), `/media/${PHOTO_NAME}`);
  assert.equal(photoPath(`/srv/appdata/stoop/photos/${PHOTO_NAME}`), `/media/${PHOTO_NAME}`);
  assert.equal(photoPath('https://example.com/a.jpg'), 'https://example.com/a.jpg');
  assert.equal(photoPath('  '), undefined);
});

test('eBay is given an absolute URL, because it fetches from the outside', () => {
  assert.equal(
    absolutePhotoUrl(PHOTO_NAME, 'https://stoop.phatt.vip'),
    `https://stoop.phatt.vip/media/${PHOTO_NAME}`,
  );
  assert.equal(
    absolutePhotoUrl(`/srv/appdata/stoop/photos/${PHOTO_NAME}`, 'https://stoop.phatt.vip/'),
    `https://stoop.phatt.vip/media/${PHOTO_NAME}`,
  );
  // A URL that is already absolute is left alone.
  assert.equal(
    absolutePhotoUrl('https://cdn.example.com/a.jpg', 'https://stoop.phatt.vip'),
    'https://cdn.example.com/a.jpg',
  );
  // No public URL means no URL — guessing one would publish the wrong address.
  assert.equal(absolutePhotoUrl(PHOTO_NAME, ''), undefined);
});

test('a photo name is taken from the last segment of a path', () => {
  assert.equal(photoNameOf(`/srv/appdata/stoop/photos/${PHOTO_NAME}`), PHOTO_NAME);
  assert.equal(photoNameOf(PHOTO_NAME), PHOTO_NAME);
  assert.equal(photoNameOf('https://example.com/a.jpg'), undefined);
});
