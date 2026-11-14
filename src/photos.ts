/**
 * Stoop — the photo path.
 *
 * One thing, done in one place, because two callers need it and they have to
 * agree exactly:
 *
 *   * the Today screen has to show Emily her print;
 *   * eBay has to be able to *fetch* the photo, because the Sell Inventory
 *     API takes a URL and downloads the picture itself. It does not take
 *     bytes.
 *
 * So the photos need to be reachable by URL from the public internet, and
 * the same URL has to be what the phone sees.
 *
 * The photos are stored as `<uuid>.<ext>` by `saveUploads`, and that name is
 * the only thing that is public about them. It is a random UUID, so the URL
 * is not guessable, and the files are product photos of items that are going
 * onto a public marketplace anyway. What is *not* served: anything that is
 * not a plain filename, and anything outside the photos directory.
 */

/** The path photos are served from. */
export const PHOTO_PATH_PREFIX = '/media/';

/** The content type for a photo file name. */
export const PHOTO_CONTENT_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.heic': 'image/heic',
};

/**
 * A file name that is safe to serve.
 *
 * No path separators, no dots beyond the extension, no traversal. The
 * uploads are `<uuid>.<ext>`, so this matches exactly what the app writes
 * and nothing else.
 */
export function safePhotoName(name: string): string | undefined {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 80) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.[A-Za-z0-9]+$/.test(trimmed)) return undefined;
  if (trimmed.includes('..')) return undefined;
  const ext = trimmed.slice(trimmed.lastIndexOf('.')).toLowerCase();
  if (!PHOTO_CONTENT_TYPES[ext]) return undefined;
  return trimmed;
}

/**
 * The photo's file name, from whatever form the reference takes.
 *
 * A reference can be a bare file name (what an upload produces), an
 * absolute path on the box (what an older record holds), or a URL (which is
 * already public and needs nothing from us).
 */
export function photoNameOf(ref: string): string | undefined {
  const trimmed = ref.trim();
  if (!trimmed) return undefined;
  if (/^https?:\/\//i.test(trimmed) || /^data:/i.test(trimmed)) return undefined;
  const base = trimmed.replace(/\/+$/, '').split('/').pop() ?? '';
  return safePhotoName(base);
}

/**
 * The path the phone and eBay use for a photo.
 *
 * A reference that is already a URL is left alone: it is somebody else's
 * picture and it is already reachable.
 */
export function photoPath(ref: string): string | undefined {
  const trimmed = ref.trim();
  if (!trimmed) return undefined;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  const name = photoNameOf(trimmed);
  if (!name) return undefined;
  return `${PHOTO_PATH_PREFIX}${name}`;
}

/**
 * The absolute URL eBay downloads the photo from.
 *
 * eBay fetches the URL from the outside, so it has to be absolute and it
 * has to be the public name of this app. A missing public URL is not
 * guessed: publishing to a marketplace that would fetch the wrong address
 * is worse than not publishing at all.
 */
export function absolutePhotoUrl(ref: string, publicUrl: string): string | undefined {
  const path = photoPath(ref);
  if (!path) return undefined;
  if (/^https?:\/\//i.test(path)) return path;
  const base = publicUrl.trim().replace(/\/+$/, '');
  if (!base) return undefined;
  return `${base}${path}`;
}
