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
import { Ledger, type Marketplace } from './ledger.ts';
import { renderShell, type TodayItem } from './ui.ts';
import { AUTH_STATE_COOKIE, SESSION_COOKIE, serializeCookie } from './session.ts';

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

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(payload);
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

function itemView(item: ReturnType<Ledger['createItem']>): Record<string, unknown> {
  return {
    id: item.id,
    title: item.title,
    description: item.description,
    priceCents: item.priceCents,
    photos: item.photos,
    tags: item.tags,
    status: item.status,
    createdAt: item.createdAt,
  };
}

export function createApp(options: ServerOptions): {
  server: Server;
  ledger: Ledger;
} {
  const ledger = options.ledger ?? new Ledger();
  const verifySession = options.verifySession;
  const auth = options.auth;

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
              sold: await ledger.isSold(item.id),
              listings: itemListings
                .filter((l) => l.marketplace !== 'facebook' || l.remoteId)
                .map((l) => ({ marketplace: l.marketplace, state: l.state })),
            };
          }),
        );
        const html = renderShell({ displayName: session.displayName, items });
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

        // GET /api/today — everything that needs Emily, and nothing else
        if (req.method === 'GET' && url.pathname === '/api/today') {
          const sellerItems = await ledger.listItems(sellerId);
          const items = await Promise.all(
            sellerItems.map(async (item) => {
              const itemListings = await ledger.listListings(item.id);
              return {
                ...itemView(item),
                listings: itemListings
                  .filter((l) => l.marketplace !== 'facebook' || l.remoteId)
                  .map((l) => ({ marketplace: l.marketplace, state: l.state, remoteId: l.remoteId })),
                sold: await ledger.isSold(item.id),
              };
            }),
          );
          json(res, 200, { items });
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
          });
          json(res, 201, { item: itemView(item) });
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
          const remoteId = typeof body.remoteId === 'string' ? body.remoteId : null;
          const listing = await ledger.publish(item.id, marketplace, remoteId);
          json(res, 200, { listing });
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
          json(res, 200, {
            outcome: result.outcome,
            endedListings: result.endedListings.length,
            needsRefund: result.needsRefund,
          });
          return;
        }

        json(res, 404, { error: 'not_found' });
        return;
      }

      json(res, 404, { error: 'not_found' });
    } catch (error) {
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
