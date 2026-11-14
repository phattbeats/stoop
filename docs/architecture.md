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
