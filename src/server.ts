/**
 * Stoop — HTTP surface.
 *
 * Deliberately dependency-free and framework-free: a phone-first shell is a
 * skin over the ledger, and a deployable artifact with no build step is easier
 * to keep alive on a 99 GB disk than a framework bundle.
 *
 * The session boundary is a pluggable verifier: `verifySession(token)` returns
 * the PHATT ID subject or null. The real OIDC implementation lands behind that
 * seam; everything here already refuses to serve without one.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { Ledger, type Marketplace } from './ledger.ts';
import { renderShell, type TodayItem } from './ui.ts';
import {
  AUTH_STATE_COOKIE,
  SESSION_COOKIE,
  decodeLoginState,
  encodeLoginState,
  serializeCookie,
} from './session.ts';
import {
  approveDraft,
  draftView,
  eligibleMarketplaces,
  makeDraft,
  rejectDraft,
  reviewProposal,
  type ListingDraft,
} from './draft.ts';
import { renderFacebookCard, type FacebookCard } from './facebook.ts';
import type { DraftStore } from './drafts.ts';
import type { DraftPhoto, DraftRequest } from './llm.ts';
import { DraftingError } from './llm.ts';
import { EtsyError, EtsyPolicyError } from './etsy.ts';
import { EtsyDeliveryError, type EtsyService } from './etsy-service.ts';
import type { RemoteActionStore } from './etsy-store.ts';
import type { DelistRunner } from './sync.ts';

/** The cookie that carries the Etsy consent attempt across the redirect. */
const ETSY_STATE_COOKIE = 'stoop_etsy_oauth';

export interface Session {
  authUserId: string;
  displayName: string;
}

export type SessionVerifier = (token: string | null) => Session | null;

export interface ServerOptions {
  ledger?: Ledger;
  verifySession: SessionVerifier;
  /** PHATT ID login. Without it the app has no way in. */
  auth?: AuthHooks;
  /** Draft storage. Without it the drafter has nowhere to put a proposal. */
  drafts?: DraftStore;
  /** The model call. Anthropic path only (src/llm.ts). */
  drafter?: Drafter;
  /** Where Emily's photos live on the box. */
  photosDir?: string;
  /** The Etsy side: publish, connect, and the paid-order webhook. */
  etsy?: EtsyService;
  /** The queue of remote actions a human may have to finish by hand. */
  remoteActions?: RemoteActionStore;
  /** Ends the other channels' listings when an item sells. */
  delist?: DelistRunner;
  /** Signs the short-lived Etsy consent cookie. */
  sessionSecret?: string;
}

/** The seam the drafter sits behind, so tests never call a model. */
export interface Drafter {
  propose(request: DraftRequest): Promise<unknown>;
}

export interface AuthHooks {
  /** URL the browser goes to, plus the short-lived state cookie to set. */
  begin: () => Promise<{ url: string; cookie: string }>;
  /** Exchange the code, mint a session, return the session token. */
  complete: (params: {
    code: string;
    state: string;
    cookie: string | null;
  }) => Promise<{ token: string; maxAgeSeconds: number } | null>;
  logout?: (token: string | null) => Promise<void>;
}

const MARKETPLACES: Marketplace[] = ['ebay', 'etsy', 'facebook'];

const MEDIA_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.heic': 'image/heic',
};

/**
 * Turn what Emily sent into images the model can see.
 *
 * Three shapes are accepted: an http(s) URL (passed through), a data URL or
 * raw base64, or a path under the photos directory on the box — which we read
 * here and inline, because the model cannot read our filesystem.
 */
async function resolvePhotos(
  input: unknown,
  photosDir: string,
): Promise<{ photos: DraftPhoto[]; refs: string[] }> {
  const raw = Array.isArray(input) ? input : [];
  const photos: DraftPhoto[] = [];
  const refs: string[] = [];

  for (const entry of raw.slice(0, 6)) {
    const ref = typeof entry === 'string' ? entry : (entry as Record<string, unknown>)?.ref;
    if (typeof ref !== 'string' || !ref.trim()) continue;
    const trimmed = ref.trim();
    refs.push(trimmed);

    if (/^https?:\/\//i.test(trimmed) || /^data:/i.test(trimmed)) {
      photos.push({ ref: trimmed });
      continue;
    }

    // A path on the box: read it, inline it, and refuse to leave the root.
    const root = resolve(photosDir);
    const full = resolve(root, trimmed.replace(/^\/+/, ''));
    if (full !== root && !full.startsWith(`${root}/`)) {
      throw new Error('photo path is outside the photos directory');
    }
    const bytes = await readFile(full);
    const mediaType =
      MEDIA_TYPES[basename(full).toLowerCase().slice(basename(full).toLowerCase().lastIndexOf('.'))] ??
      'image/jpeg';
    photos.push({ ref: bytes.toString('base64'), mediaType });
  }

  return { photos, refs };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

function readCookie(req: IncomingMessage, name: string): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

async function readRaw(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/**
 * Save what Emily's phone uploaded into the photos directory.
 *
 * The file name is ours, not hers: a UUID and the type's extension. Nothing
 * from the client can steer the path.
 */
async function saveUploads(form: FormData, photosDir: string): Promise<string[]> {
  const saved: string[] = [];
  const root = resolve(photosDir);
  for (const entry of form.getAll('photo')) {
    if (typeof entry === 'string') continue;
    if (!entry || typeof (entry as File).arrayBuffer !== 'function') continue;
    const file = entry as File;
    if (!file.size) continue;
    const ext =
      ({
        'image/jpeg': 'jpg',
        'image/png': 'png',
        'image/webp': 'webp',
        'image/gif': 'gif',
        'image/heic': 'heic',
      })[file.type] ?? 'jpg';
    const name = `${randomUUID()}.${ext}`;
    await mkdir(root, { recursive: true });
    await writeFile(join(root, name), Buffer.from(await file.arrayBuffer()));
    saved.push(name);
    if (saved.length >= 6) break;
  }
  return saved;
}

/**
 * Read one of Emily's photos as bytes, for a marketplace that wants bytes.
 *
 * Only files under the photos directory are read. A photo on her phone is a
 * file on the box, not a URL we would fetch from somewhere else.
 */
async function readLocalImage(
  ref: string,
  photosDir: string,
): Promise<{ data: Buffer; contentType: string } | null> {
  const trimmed = ref.trim();
  if (!trimmed || /^https?:\/\//i.test(trimmed) || /^data:/i.test(trimmed)) return null;
  const root = resolve(photosDir);
  const full = trimmed.startsWith('/')
    ? resolve(trimmed)
    : resolve(root, trimmed.replace(/^\/+/, ''));
  if (full !== root && !full.startsWith(`${root}/`)) return null;
  try {
    const bytes = await readFile(full);
    const ext = basename(full).toLowerCase().slice(basename(full).toLowerCase().lastIndexOf('.'));
    const contentType = MEDIA_TYPES[`.${ext}`] ?? 'image/jpeg';
    return { data: bytes, contentType };
  } catch {
    return null;
  }
}

function itemView(item: ReturnType<Ledger['createItem']>): Record<string, unknown> {
  return {
    id: item.id,
    title: item.title,
    description: item.description,
    priceCents: item.priceCents,
    photos: item.photos,
    tags: item.tags,
    condition: item.condition,
    originalOrVintage: item.originalOrVintage,
    status: item.status,
    createdAt: item.createdAt,
  };
}

/** The Facebook paste card for one item, rendered from the item record. */
function facebookCardFor(item: ReturnType<Ledger['createItem']>): FacebookCard {
  return renderFacebookCard({
    title: item.title,
    description: item.description,
    priceCents: item.priceCents,
    condition: item.condition,
    originalOrVintage: item.originalOrVintage,
    photoCount: item.photos.length,
  });
}

export function createApp(options: ServerOptions): {
  server: Server;
  ledger: Ledger;
} {
  const ledger = options.ledger ?? new Ledger();
  const verifySession = options.verifySession;
  const auth = options.auth;
  const drafts = options.drafts;
  const drafter = options.drafter;
  const photosDir = options.photosDir ?? '/srv/appdata/stoop/photos';
  const etsy = options.etsy;
  const remoteActions = options.remoteActions;
  const delist = options.delist;
  const sessionSecret = options.sessionSecret;

  const sellerFor = async (session: Session): Promise<string> => {
    const allItems = await ledger.listItems();
    const sellers = await Promise.all(allItems.map((i) => ledger.getSeller(i.sellerId)));
    const existing = sellers.find((s) => s?.authUserId === session.authUserId);
    if (existing) return existing.id;
    const seller = await ledger.addSeller({
      id: `seller_${session.authUserId}`,
      authUserId: session.authUserId,
      displayName: session.displayName,
    });
    return seller.id;
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const token = readCookie(req, SESSION_COOKIE);
      const session = verifySession(token);

      if (req.method === 'GET' && url.pathname === '/healthz') {
        json(res, 200, { ok: true });
        return;
      }

      // ── Etsy's paid-order webhook (PHA-5096) ───────────────────────────────
      // This one is public and unauthenticated on purpose: Etsy has no
      // session. What makes it safe is the signature over the raw bytes, the
      // replay window, and the receipt being fetched before anything moves.
      if (url.pathname === '/webhooks/etsy' && req.method === 'POST') {
        if (!etsy) {
          json(res, 503, { error: 'etsy_not_configured' });
          return;
        }
        const raw = await readRaw(req);
        try {
          const result = await etsy.handleDelivery(raw, {
            id: header(req, 'webhook-id'),
            timestamp: header(req, 'webhook-timestamp'),
            signature: header(req, 'webhook-signature'),
          });
          json(res, 200, result);
        } catch (error) {
          if (error instanceof EtsyDeliveryError) {
            // A forged or replayed delivery: say so and stop.
            json(res, 401, { error: error.reason });
            return;
          }
          // Anything else is transient (the receipt could not be fetched).
          // Etsy retries those, and a retry is how the receipt arrives.
          json(res, 500, { error: 'delivery_failed', detail: String((error as Error).message ?? error) });
        }
        return;
      }

      // ── PHATT ID login (PHA-5092) ───────────────────────────────────────────
      if (url.pathname === '/auth/login' && req.method === 'GET') {
        if (session) {
          res.writeHead(302, { location: '/' });
          res.end();
          return;
        }
        if (!auth) {
          json(res, 404, { error: 'not_found' });
          return;
        }
        const started = await auth.begin();
        res.writeHead(302, {
          location: started.url,
          'set-cookie': serializeCookie(AUTH_STATE_COOKIE, started.cookie, { maxAgeSeconds: 600 }),
        });
        res.end();
        return;
      }

      if (url.pathname === '/auth/callback' && req.method === 'GET') {
        if (!auth) {
          json(res, 404, { error: 'not_found' });
          return;
        }
        const result = await auth.complete({
          code: url.searchParams.get('code') ?? '',
          state: url.searchParams.get('state') ?? '',
          cookie: readCookie(req, AUTH_STATE_COOKIE),
        });
        if (!result) {
          res.writeHead(302, { location: '/?error=login_failed' });
          res.end();
          return;
        }
        res.writeHead(302, {
          location: '/',
          'set-cookie': [
            serializeCookie(SESSION_COOKIE, result.token, { maxAgeSeconds: result.maxAgeSeconds }),
            serializeCookie(AUTH_STATE_COOKIE, '', { maxAgeSeconds: 0 }),
          ],
        });
        res.end();
        return;
      }

      if (url.pathname === '/auth/logout' && (req.method === 'POST' || req.method === 'GET')) {
        if (auth?.logout) await auth.logout(token);
        res.writeHead(302, {
          location: '/',
          'set-cookie': serializeCookie(SESSION_COOKIE, '', { maxAgeSeconds: 0 }),
        });
        res.end();
        return;
      }

      if (req.method === 'GET' && url.pathname === '/') {
        if (!session) {
          res.writeHead(302, { location: '/auth/login' });
          res.end();
          return;
        }
        const sellerId = await sellerFor(session);
        const sellerItems = await ledger.listItems(sellerId);
        const items: TodayItem[] = await Promise.all(
          sellerItems.map(async (item) => {
            const itemListings = await ledger.listListings(item.id);
            return {
              id: item.id,
              title: item.title,
              priceCents: item.priceCents,
              status: item.status,
              photos: item.photos,
              condition: item.condition,
              originalOrVintage: item.originalOrVintage,
              sold: await ledger.isSold(item.id),
              needsRefund: (await ledger.getDuplicateSales(item.id)).length > 0,
              postedOnFacebook: itemListings.some(
                (l) => l.marketplace === 'facebook' && l.state === 'live',
              ),
              card: facebookCardFor(item),
              listings: itemListings.map((l) => ({ marketplace: l.marketplace, state: l.state })),
            };
          }),
        );
        const pending = drafts
          ? (await drafts.listForSeller(sellerId)).filter((draft) => draft.status === 'draft')
          : [];
        // The queue a human has to work through: a listing that could not be
        // ended on the other marketplace. A queue nobody can see is not
        // surfaced, it is just lost.
        const openActions = remoteActions ? await remoteActions.listOpen() : [];
        const html = renderShell({
          displayName: session.displayName,
          items,
          actions: openActions
            .filter((action) => action.needsHuman)
            .map((action) => ({
              id: action.id,
              marketplace: action.marketplace,
              what:
                action.action === 'delist'
                  ? `A ${action.marketplace} listing still needs to be ended by hand`
                  : `A ${action.marketplace} sale needs a look`,
              ...(action.lastError ? { detail: action.lastError } : {}),
            })),
          drafts: pending.map((draft) => ({
            id: draft.id,
            title: draft.title,
            priceRange: draft.priceRange,
            tags: draft.tags,
            shipping: draft.shipping,
            flags: draft.flags,
            confidence: draft.confidence,
            notes: draft.notes,
          })),
        });
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
        });
        res.end(html);
        return;
      }

      if (url.pathname.startsWith('/api/')) {
        if (!session) {
          json(res, 401, { error: 'sign_in_required' });
          return;
        }
        const sellerId = await sellerFor(session);

        // ── Etsy: connect Emily's account (PHA-5096) ─────────────────────────
        // Emily consents. The app never logs in for her, and the consent
        // cookie dies in ten minutes.

        if (req.method === 'GET' && url.pathname === '/api/etsy/connect') {
          if (!etsy) {
            json(res, 503, { error: 'etsy_not_configured' });
            return;
          }
          if (!sessionSecret) {
            json(res, 503, { error: 'session_secret_missing' });
            return;
          }
          const state = randomBytes(24).toString('base64url');
          const verifier = randomBytes(32).toString('base64url');
          const challenge = createHash('sha256').update(verifier).digest('base64url');
          const cookie = encodeLoginState(
            { state, nonce: state, verifier, ts: Date.now() },
            sessionSecret,
          );
          res.writeHead(302, {
            location: etsy.authorizationUrl(state, challenge),
            'set-cookie': serializeCookie(ETSY_STATE_COOKIE, cookie, { maxAgeSeconds: 600 }),
          });
          res.end();
          return;
        }

        if (req.method === 'GET' && url.pathname === '/api/etsy/callback') {
          if (!etsy) {
            json(res, 503, { error: 'etsy_not_configured' });
            return;
          }
          if (!sessionSecret) {
            json(res, 503, { error: 'session_secret_missing' });
            return;
          }
          const code = url.searchParams.get('code') ?? '';
          const state = url.searchParams.get('state') ?? '';
          const saved = decodeLoginState(readCookie(req, ETSY_STATE_COOKIE) ?? undefined, sessionSecret);
          if (!code || !saved || saved.state !== state) {
            json(res, 400, { error: 'etsy_callback_invalid' });
            return;
          }
          try {
            await etsy.completeAuthorization(sellerId, code, saved.verifier);
          } catch (error) {
            json(res, 502, { error: 'etsy_connect_failed', detail: String((error as Error).message ?? error) });
            return;
          }
          res.writeHead(302, { location: '/' });
          res.end();
          return;
        }

        // GET /api/actions — what a human has to finish by hand
        if (req.method === 'GET' && url.pathname === '/api/actions') {
          if (!remoteActions) {
            json(res, 501, { error: 'remote_actions_unavailable' });
            return;
          }
          const open = await remoteActions.listOpen();
          json(res, 200, {
            actions: open.map((action) => ({
              id: action.id,
              marketplace: action.marketplace,
              action: action.action,
              remoteId: action.remoteId ?? null,
              state: action.state,
              needsHuman: action.needsHuman,
              attempts: action.attempts,
              lastError: action.lastError ?? null,
              itemId: action.itemId ?? null,
            })),
          });
          return;
        }

        // GET /api/today — everything that needs Emily, and nothing else
        if (req.method === 'GET' && url.pathname === '/api/today') {
          const sellerItems = await ledger.listItems(sellerId);
          const items = await Promise.all(
            sellerItems.map(async (item) => {
              const itemListings = await ledger.listListings(item.id);
              return {
                ...itemView(item),
                listings: itemListings.map((l) => ({
                  marketplace: l.marketplace,
                  state: l.state,
                  remoteId: l.remoteId,
                })),
                sold: await ledger.isSold(item.id),
                needsRefund: (await ledger.getDuplicateSales(item.id)).length > 0,
                postedOnFacebook: itemListings.some(
                  (l) => l.marketplace === 'facebook' && l.state === 'live',
                ),
                card: facebookCardFor(item),
              };
            }),
          );
          const openActions = remoteActions ? await remoteActions.listOpen() : [];
          json(res, 200, {
            items,
            actions: openActions
              .filter((action) => action.needsHuman)
              .map((action) => ({
                id: action.id,
                marketplace: action.marketplace,
                action: action.action,
                remoteId: action.remoteId ?? null,
                state: action.state,
                lastError: action.lastError ?? null,
              })),
          });
          return;
        }

        // POST /api/items — one record, one place
        if (req.method === 'POST' && url.pathname === '/api/items') {
          const body = await readJson(req);
          const title = typeof body.title === 'string' ? body.title.trim() : '';
          const priceCents = Number(body.priceCents);
          if (!title) {
            json(res, 400, { error: 'title_required' });
            return;
          }
          if (!Number.isFinite(priceCents) || priceCents < 0) {
            json(res, 400, { error: 'price_cents_invalid' });
            return;
          }
          const photos = Array.isArray(body.photos)
            ? body.photos.filter((p): p is string => typeof p === 'string')
            : [];
          const item = await ledger.createItem({
            sellerId,
            title,
            description: typeof body.description === 'string' ? body.description : '',
            priceCents: Math.round(priceCents),
            photos,
            tags: Array.isArray(body.tags)
              ? body.tags.filter((t): t is string => typeof t === 'string')
              : [],
            condition: typeof body.condition === 'string' ? body.condition : 'unspecified',
            originalOrVintage:
              body.originalOrVintage === true
                ? true
                : body.originalOrVintage === false
                  ? false
                  : null,
          });
          json(res, 201, { item: itemView(item) });
          return;
        }

        // PATCH /api/items/:id — the facts of an item nothing else is live from
        const patchMatch = url.pathname.match(/^\/api\/items\/([^/]+)$/);
        if (req.method === 'PATCH' && patchMatch) {
          const item = await ledger.getItem(patchMatch[1]);
          if (!item || item.sellerId !== sellerId) {
            json(res, 404, { error: 'item_not_found' });
            return;
          }
          const body = await readJson(req);
          const patch: {
            title?: string;
            description?: string;
            priceCents?: number;
            condition?: string;
            originalOrVintage?: boolean | null;
          } = {};
          if (typeof body.title === 'string') patch.title = body.title;
          if (typeof body.description === 'string') patch.description = body.description;
          if (body.priceCents !== undefined && body.priceCents !== null) {
            const priceCents = Number(body.priceCents);
            if (!Number.isFinite(priceCents) || priceCents < 0) {
              json(res, 400, { error: 'price_cents_invalid' });
              return;
            }
            patch.priceCents = Math.round(priceCents);
          }
          if (typeof body.condition === 'string') patch.condition = body.condition;
          if (body.originalOrVintage === true || body.originalOrVintage === false) {
            patch.originalOrVintage = body.originalOrVintage;
          }
          const updated = await ledger.updateItem(item.id, patch);
          json(res, 200, { item: itemView(updated), card: facebookCardFor(updated) });
          return;
        }

        // POST /api/items/:id/publish — publish one record to one marketplace
        const publishMatch = url.pathname.match(/^\/api\/items\/([^/]+)\/publish$/);
        if (req.method === 'POST' && publishMatch) {
          const item = await ledger.getItem(publishMatch[1]);
          if (!item || item.sellerId !== sellerId) {
            json(res, 404, { error: 'item_not_found' });
            return;
          }
          const body = await readJson(req);
          const marketplace = String(body.marketplace ?? '') as Marketplace;
          if (!MARKETPLACES.includes(marketplace)) {
            json(res, 400, { error: 'unknown_marketplace' });
            return;
          }
          if (marketplace === 'facebook') {
            // Facebook is a paste card, not a listing Stoop can create.
            json(res, 400, { error: 'facebook_requires_paste_card' });
            return;
          }
          let remoteId = typeof body.remoteId === 'string' ? body.remoteId : null;

          // Etsy is published through the adapter, so Etsy's own rules apply
          // at write time. A manual remote id is the pre-adapter path and is
          // kept only for a listing somebody else already created.
          if (marketplace === 'etsy' && !remoteId) {
            if (!etsy) {
              json(res, 503, { error: 'etsy_not_configured' });
              return;
            }
            if (item.originalOrVintage !== true) {
              json(res, 400, {
                error: 'etsy_original_vintage_only',
                detail: 'etsy is original/vintage only; this item does not say it is either',
              });
              return;
            }
            const images = [];
            for (const ref of item.photos) {
              const image = await readLocalImage(ref, photosDir);
              if (image) images.push(image);
            }
            try {
              const published = await etsy.publishListing({
                itemId: item.id,
                title: item.title,
                description: item.description,
                priceCents: item.priceCents,
                tags: item.tags,
                originalOrVintage: item.originalOrVintage,
                images,
                ...(typeof body.taxonomyId === 'number' ? { taxonomyId: body.taxonomyId } : {}),
                ...(typeof body.shippingProfileId === 'number'
                  ? { shippingProfileId: body.shippingProfileId }
                  : {}),
                ...(body.whoMade === 'i_did' || body.whoMade === 'someone_else' || body.whoMade === 'collective'
                  ? { whoMade: body.whoMade }
                  : {}),
                ...(typeof body.whenMade === 'string' ? { whenMade: body.whenMade } : {}),
              });
              remoteId = published.remoteId;
            } catch (error) {
              if (error instanceof EtsyPolicyError) {
                json(res, 400, { error: error.code, detail: error.message });
                return;
              }
              if (error instanceof EtsyError) {
                json(res, 502, { error: 'etsy_publish_failed', detail: error.message });
                return;
              }
              throw error;
            }
          }

          const listing = await ledger.publish(item.id, marketplace, remoteId);
          json(res, 200, { listing });
          return;
        }

        // GET /api/items/:id/facebook-card — the text she pastes
        const cardMatch = url.pathname.match(/^\/api\/items\/([^/]+)\/facebook-card$/);
        if (req.method === 'GET' && cardMatch) {
          const item = await ledger.getItem(cardMatch[1]);
          if (!item || item.sellerId !== sellerId) {
            json(res, 404, { error: 'item_not_found' });
            return;
          }
          json(res, 200, { card: facebookCardFor(item) });
          return;
        }

        // POST /api/items/:id/facebook/posted — she pasted it, it is up
        const postedMatch = url.pathname.match(/^\/api\/items\/([^/]+)\/facebook\/posted$/);
        if (req.method === 'POST' && postedMatch) {
          const item = await ledger.getItem(postedMatch[1]);
          if (!item || item.sellerId !== sellerId) {
            json(res, 404, { error: 'item_not_found' });
            return;
          }
          const listing = await ledger.markPostedOnFacebook(item.id);
          json(res, 200, { listing, card: facebookCardFor(item) });
          return;
        }

        // POST /api/items/:id/mark-sold — the Facebook tap
        const soldMatch = url.pathname.match(/^\/api\/items\/([^/]+)\/mark-sold$/);
        if (req.method === 'POST' && soldMatch) {
          const item = await ledger.getItem(soldMatch[1]);
          if (!item || item.sellerId !== sellerId) {
            json(res, 404, { error: 'item_not_found' });
            return;
          }
          const result = await ledger.markSold(item.id, `manual_${item.id}`);
          const duplicates = await ledger.getDuplicateSales(item.id);
          // The local sale is the truth. Ending the other channels is a
          // remote call that can fail, so it is queued, not promised.
          const delistOutcome = delist
            ? await delist.delist(
                result.endedListings.map((listing) => ({
                  listingId: listing.id,
                  itemId: listing.itemId,
                  marketplace: listing.marketplace,
                  remoteId: listing.remoteId,
                })),
              )
            : undefined;
          json(res, 200, {
            outcome: result.outcome,
            endedListings: result.endedListings.length,
            delisted: delistOutcome?.succeeded ?? 0,
            needsHuman: delistOutcome?.needsHuman ?? 0,
            ended: result.endedListings.map((l) => ({
              marketplace: l.marketplace,
              state: l.state,
              endReason: l.endReason,
            })),
            needsRefund: result.needsRefund || duplicates.length > 0,
            refunds: duplicates.map((sale) => ({
              marketplace: sale.marketplace,
              orderId: sale.orderId,
              amountCents: sale.amountCents,
            })),
            sold: true,
          });
          return;
        }

        // ── The listing drafter (PHA-5095) ────────────────────────────────────
        // Photograph it, the model proposes, Emily approves. The model never
        // publishes anything; it only ever produces a draft.

        if (req.method === 'POST' && url.pathname === '/api/drafts') {
          if (!drafts || !drafter) {
            json(res, 501, { error: 'drafter_unavailable' });
            return;
          }
          const contentType = String(req.headers['content-type'] ?? '');
          let photosInput: unknown = [];
          let notes = '';
          let hints: string[] = [];
          let marketplaces: string[] = [];
          let priceHint: string | undefined;

          if (contentType.includes('multipart/form-data')) {
            // Emily's phone: a photo, optionally with a note typed alongside it.
            const raw = await readRaw(req);
            const form = await new Response(new Uint8Array(raw), { headers: { 'content-type': contentType } }).formData();
            const notesField = form.get('notes');
            notes = typeof notesField === 'string' ? notesField.trim().slice(0, 4000) : '';
            const marketplacesField = form.get('marketplaces');
            if (typeof marketplacesField === 'string') {
              marketplaces = marketplacesField
                .split(',')
                .map((m) => m.trim())
                .filter(Boolean)
                .slice(0, 3);
            }
            photosInput = await saveUploads(form, photosDir);
          } else {
            const body = await readJson(req);
            photosInput = body.photos;
            notes = typeof body.notes === 'string' ? body.notes.trim().slice(0, 4000) : '';
            hints = Array.isArray(body.hints)
              ? body.hints.filter((hint): hint is string => typeof hint === 'string').slice(0, 12)
              : [];
            marketplaces = Array.isArray(body.marketplaces)
              ? (body.marketplaces as unknown[])
                  .filter((m): m is string => typeof m === 'string')
                  .slice(0, 3)
              : [];
            priceHint = typeof body.priceHint === 'string' ? body.priceHint.slice(0, 80) : undefined;
          }

          const photos = await resolvePhotos(photosInput, photosDir);
          if (photos.photos.length === 0) {
            json(res, 400, { error: 'photos_required' });
            return;
          }

          const proposed = await drafter.propose({
            photos: photos.photos,
            notes,
            hints,
            marketplaces,
            ...(priceHint ? { priceHint } : {}),
          });
          const review = reviewProposal(proposed);
          if (!review.usable) {
            json(res, 422, { error: 'draft_unusable', problems: review.problems });
            return;
          }

          const draft = makeDraft({
            id: randomUUID(),
            sellerId,
            proposal: review.proposal,
            photos: photos.refs,
            notes,
            now: new Date().toISOString(),
          });
          await drafts.create(draft);
          json(res, 201, {
            draft: draftView(draft),
            marketplaces: eligibleMarketplaces(draft),
            corrections: review.corrections,
          });
          return;
        }

        // GET /api/drafts — what is waiting on Emily
        if (req.method === 'GET' && url.pathname === '/api/drafts') {
          if (!drafts) {
            json(res, 501, { error: 'drafter_unavailable' });
            return;
          }
          const all = await drafts.listForSeller(sellerId);
          const pending = all.filter((draft) => draft.status === 'draft');
          const decided = all.filter((draft) => draft.status !== 'draft');
          json(res, 200, {
            drafts: [...pending, ...decided].map((draft) => ({
              ...draftView(draft),
              marketplaces: eligibleMarketplaces(draft),
            })),
          });
          return;
        }

        // POST /api/drafts/:id/approve — Emily says yes; the item record exists
        const approveMatch = url.pathname.match(/^\/api\/drafts\/([^/]+)\/approve$/);
        if (req.method === 'POST' && approveMatch) {
          if (!drafts) {
            json(res, 501, { error: 'drafter_unavailable' });
            return;
          }
          const draft = await drafts.get(approveMatch[1]);
          if (!draft || draft.sellerId !== sellerId) {
            json(res, 404, { error: 'draft_not_found' });
            return;
          }
          const body = await readJson(req);
          const priceRaw = body.priceCents;
          const outcome = approveDraft(
            draft,
            {
              ...(priceRaw === undefined || priceRaw === null ? {} : { priceCents: Number(priceRaw) }),
              ...(typeof body.title === 'string' ? { title: body.title } : {}),
              ...(typeof body.description === 'string' ? { description: body.description } : {}),
              ...(Array.isArray(body.tags) ? { tags: body.tags.filter((t): t is string => typeof t === 'string') } : {}),
            },
            new Date().toISOString(),
          );
          const item = await ledger.createItem({
            sellerId,
            title: outcome.item.title,
            description: outcome.item.description,
            priceCents: outcome.item.priceCents,
            photos: outcome.item.photos,
            tags: outcome.item.tags,
            condition: outcome.item.condition,
            originalOrVintage: outcome.item.originalOrVintage,
          });
          outcome.draft.itemId = item.id;
          await drafts.save(outcome.draft);
          json(res, 200, { draft: draftView(outcome.draft), item: itemView(item) });
          return;
        }

        // POST /api/drafts/:id/reject — Emily says no; nothing is created
        const rejectMatch = url.pathname.match(/^\/api\/drafts\/([^/]+)\/reject$/);
        if (req.method === 'POST' && rejectMatch) {
          if (!drafts) {
            json(res, 501, { error: 'drafter_unavailable' });
            return;
          }
          const draft = await drafts.get(rejectMatch[1]);
          if (!draft || draft.sellerId !== sellerId) {
            json(res, 404, { error: 'draft_not_found' });
            return;
          }
          const rejected = rejectDraft(draft, new Date().toISOString());
          await drafts.save(rejected);
          json(res, 200, { draft: draftView(rejected) });
          return;
        }

        json(res, 404, { error: 'not_found' });
        return;
      }

      json(res, 404, { error: 'not_found' });
    } catch (error) {
      if (error instanceof DraftingError) {
        json(res, 502, { error: 'drafting_failed', detail: error.detail });
        return;
      }
      json(res, 400, { error: 'bad_request', detail: String((error as Error).message ?? error) });
    }
  });

  return { server, ledger };
}

export function listen(server: Server, port = 0): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      const boundPort = typeof address === 'object' && address ? address.port : port;
      resolve({
        port: boundPort,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}
