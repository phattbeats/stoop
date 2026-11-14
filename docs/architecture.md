# Stoop — architecture

Emily's one-record listing app. eBay + Etsy + a Facebook paste card, PHATT ID login.

## 1. What is this an instance of?

Not "a crosslister". It is an **authority-bound inventory-state problem**: one SKU must have one
source of truth, writes must use each marketplace's sanctioned API/auth model, and a sale must
atomically stop every other channel. The failure mode that matters is a double sale during
webhook lag — not a missing feature.

That reframing is why the research pass said no to OSS crosslisters: they do not solve
authentication, order authority, anti-double-sale, or marketplace terms.

## 2. Irreducible constraints

These cannot move, so everything else is a choice:

1. eBay Inventory-API listings **cannot be revised in Seller Hub** — the API is the only editor.
   Therefore the draft → approve → publish flow is not a UI nicety, it is the product.
2. Etsy `order.paid` is the order-authority path in scope: HMAC-verified, timestamp-tolerant,
   `webhook-id` as idempotency key, receipt fetched from `resource_url` **before** stock moves.
3. Emily creates her own eBay/Etsy accounts and does the OAuth consent. Agents never log in for her.
4. Facebook is a paste card. No browser automation against Emily's account.
5. Drafting goes through the LiteLLM Anthropic path only.
6. One inventory record per item; multi-tenant, keyed on seller.

Everything else — language, framework, where the photos live — is a choice we get to make.

## 3. What a principal architect would rewrite before starting

The "one record, publish everywhere" screen. A generic listing form that pretends eBay and Etsy
are the same shape forces every difference (Etsy original/vintage only, eBay business policies,
Etsy 1-hour tokens) into conditional fields in one form. Instead: one canonical item record,
plus a per-marketplace *adapter* that knows that marketplace's shape, its auth, and its terms.
The screen stays simple because the differences live behind adapters.

Price it: an adapter interface (`publish`, `end`, `fetchSale`) plus one eBay and one Etsy
implementation. The item record never learns what an Etsy listing is.

## 4. The abstraction one level up

**A listing is a projection of an item, and a sale is the only thing that ends projections.**

So the model is: `items` (canonical) → `listings` (one per marketplace, revised in place) →
`sales` (exactly one per item, enforced by a unique constraint). The anti-double-sale behaviour
is not a scheduled job or a "check before publish" routine — it is a database constraint plus
idempotent event handling. The 60-second break test becomes a property of the schema.

## 5. The test that breaks this design on day one

**Buy the same item on eBay and Etsy within 60 seconds.**

- First valid sale wins, auto-cancels the other listing, no human.
- The second sale is recorded as a duplicate with `needs_refund = true` — not dropped. The money
  moved even though the item did not; silently dropping it is how you lose a customer.
- A redelivered webhook (same event id) changes nothing.

Implemented and tested in `src/ledger.ts` / `test/ledger.test.ts`; the same invariants are
expressed as constraints in `db/schema.sql`.

A second day-one breaker: **the same webhook arriving twice** (Etsy retries). Covered by the
`order_events` idempotency key.

## The Facebook card (PHA-5097)

Facebook is not a channel the app can write to. No browser automation, no login, no scraping — so
the honest abstraction is not "a third adapter" but **a channel that must be written by the human,
and therefore a card plus a state**:

- The app's job on Facebook is to produce the exact text and to track whether the human did it.
- "Posted on FB" is a **state on the listing**, not a remote id: `marketplace = 'facebook'`,
  `remote_id = null`, forever. There is no Facebook listing id because Stoop never touches
  Facebook. Publishing to Facebook is refused outright — it would claim a listing the app did not
  create and cannot manage.
- A paste card is not inventory. It becomes a listing only when she says it is posted.

The honesty rules are the product, and they run off the **item record**, not off the model:

- The condition comes from `items.condition`. If nobody has recorded one, the card is *not ready* —
  the app does not invent a condition for a buyer.
- `items.original_or_vintage` is a three-valued fact: yes / no / not asserted. The card says
  "Original or vintage: yes" or ": no" when the record says so, and says nothing at all when the
  record does not. A "made by someone else" item is never rounded up to "vintage" — the same rule
  Etsy enforces per item at write time.
- The photos are on Emily's phone. Stoop does not host them for Facebook, so the card carries that
  as an instruction to her and keeps it *out* of the pasted text.

**The day-one breaker for this slice:** she taps **Mark sold** on the Facebook listing. The sale
wins, every other listing ends with no human in the loop (`sold_on_facebook`), and a second
real-world sale on another channel is recorded as `needs_refund` — never dropped, because the money
moved even though the item did not.

**One rule that fell out of it:** an item is editable only while it is live on no channel the app
publishes to. eBay Inventory-API listings cannot be revised in Seller Hub, so the record they were
published from has to stay true — the same reason the draft→approve→publish flow exists at all.

## The Etsy adapter and the sold-sync (PHA-5096)

### 1. What this is an instance of

Not "an Etsy integration". It is **a webhook ingest problem under an authority chain**: untrusted
bytes → a verified event → an authoritative receipt → a state transition → a best-effort remote
delist. Every step can fail, and the interesting failures are in the middle of the chain, not at
its ends.

### 2. The irreducible constraints

1. Etsy's signature is computed over `webhook-id + "." + webhook-timestamp + "." + raw_body`,
   base64 HMAC-SHA256 with the portal's signing secret. The raw bytes, or nothing verifies.
2. The timestamp window is 300 seconds either way. A captured delivery must not replay.
3. The `webhook-id` is the idempotency key, because Etsy retries on a schedule measured in hours.
4. The receipt is fetched from the event's `resource_url` **before** stock moves. A webhook is a
   claim; the receipt is the proof.
5. Etsy is original/vintage only, and that is enforced per item at write time — the
   `listings_w` create call, not the UI.
6. Access tokens last an hour; refresh tokens have a ~90 day functional lifetime, so a refresh
   that fails means "Emily has to consent again", not "retry harder".
7. Quota is per API key on a sliding window: a 429 carries `retry-after` and is a wait, not a
   failure.

### 3. What a principal architect would rewrite before starting

The naive version puts Etsy's rules inside the HTTP layer: `if (marketplace === 'etsy')` in the
publish route, a signature check inline in the webhook route, and a second copy of "fetch the
receipt first" per channel.

Instead there is an **adapter seam** (`src/adapter.ts`): `publish`, `end`, and nothing else. The
item record never learns what an Etsy listing is; it only ever sees a remote id and a state. The
Etsy-specific rules live in `src/etsy.ts` and the delivery rules live in `src/etsy-webhook.ts`.

### 4. The abstraction one level up

**A sale is a state transition with a compensating action**, and the compensating action is not
atomic with it.

Ending the other channels' listings is a network call to somebody else's API. It can fail, be
slow, or be rate limited. So it is not promised:

- the sale is recorded and the other listings are ended **locally**, in the same transaction;
- each ended listing with a remote id becomes a queued **remote action** (`remote_actions`);
- the action is attempted once, right away;
- if it fails — or if there is no adapter for that marketplace yet — it stays visible with
  `needs_human = true`, and only a human finishes it.

The failure this avoids: telling Emily the painting is sold everywhere, and finding out three
days later that the eBay listing is still up and gets bought by somebody else.

### 5. The day-one breakers for this slice

- **A forged webhook.** It must not move anything. (`test/etsy-webhook.test.ts`)
- **A replayed webhook** — same id, or a timestamp outside the window. It must change nothing.
  (`test/etsy-sold-sync.test.ts`)
- **A sale for a listing Stoop does not know.** The money moved, so it is queued for a human and
  acknowledged, not silently dropped and not recorded against the wrong item.

The Etsy-specific publish rules have their own breakers: an item that is not original/vintage is
refused **at write time**; a 429 is waited out; a receipt URL that is not Etsy's is never fetched.

### Sold-sync, in order

1. `POST /webhooks/etsy` — public, because Etsy has no session.
2. Verify the signature over the raw bytes, then the timestamp window, then parse.
3. `order.paid` only; every other event is acknowledged and ignored.
4. Fetch the receipt from `resource_url` (Etsy's hosts only — a payload must not become a fetch
   to anywhere).
5. Find the item by the listing id in the receipt, not by anything the webhook said.
6. Record the sale: the webhook id is the idempotency key, the receipt is stored with it.
7. Queue and attempt the cross-channel delist.

## Stack

- Next.js (App Router) + Postgres, one service in the vps1 compose file (`/srv/compose.yml`).
- Authentik OIDC at `https://auth.phatt.vip/application/o/stoop/` — the live issuer is **vps1**;
  the RAID's `authentik-server` container is an `alpine/socat` mirror of vps1, not the authority.
- Photos in `/srv/appdata/stoop`; nightly encrypted backup to RAID + Wasabi.
- Phone-first PWA; the Today screen is the default view, notifications only for action-needed.

## Deploy shape (vps1)

Cloudflare → Caddy (`/srv/caddy/Caddyfile`) → `stoop` container on the compose network.
**No host port is published and no nftables rule is added** — 80/443 already accept Cloudflare
ranges, and Caddy reaches the app inside the Docker network.

Disk is the constraint on that host (99 G, 26 G free). Stoop's budget: ≤ 8 GB for images,
photos and artifacts.

## Open, owner-gated

- eBay production keyset + quota — resolve in the Developer Portal, not from dead doc URLs.
- Etsy business review + terms obligations — logged-in read required.
- `stoop.phatt.vip` DNS record — added when the app serves.
