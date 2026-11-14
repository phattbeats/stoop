# Stoop

Emily's one-record listing app. Photograph an item, approve the AI draft, publish to eBay and
Etsy, paste a card into Facebook Marketplace. One inventory record per item; a sale anywhere
ends the other listings.

PHATT ID (Authentik) login. No browser automation against Emily's accounts.

## What is here right now

| Path | What |
|---|---|
| `src/ledger.ts` | The canonical inventory ledger: one record per item, one listing per marketplace, one sale per item, auto-cancel on sale. The domain rules the product lives on. |
| `src/adapter.ts` | The marketplace seam: `publish` and `end`, and nothing else. The item record never learns what an Etsy listing is. |
| `src/etsy.ts` | The Etsy adapter: OAuth + PKCE, listing create → image → activate, delist, quota handling, original/vintage enforced at write time. |
| `src/etsy-webhook.ts` | Etsy's signature (HMAC-SHA256 over `id.timestamp.raw_body`), the 300-second replay window, and the event shape. |
| `src/etsy-service.ts` | The sold-sync: verify → receipt → record the sale → queue the cross-channel delist. |
| `src/ebay.ts` | The eBay adapter: Sell Inventory, publish as inventory item → offer → listing policies → read-back. A SKU derived from Stoop's own item id, and an offer that is not live is a failure, not a silent success. |
| `src/ebay-client.ts` | The eBay transport: OAuth2 with PKCE, the marketplace header, 401-replay-once, and 429 `Retry-After`. Sandbox and production are separate hosts and never guessed. |
| `src/ebay-service.ts` | The eBay consent flow. Emily connects her own account; nothing here consents for her. |
| `src/ebay-store.ts` | The eBay token store (Postgres and memory), keyed per environment, and the token manager that refreshes before expiry. |
| `src/ebay-orders.ts` | The eBay sale sync: polls the Fulfillment API for orders and joins them back to Stoop through the seller SKU. |
| `src/photos.ts` | The photo path: one URL for the phone and for eBay, at an unguessable name. |
| `src/sync.ts` | The remote action queue: the cross-channel delist is attempted, and left for a human when it fails. |
| `src/facebook.ts` | The Facebook paste card: the text Emily copies, the photos she has to attach herself, and the honesty rules (condition, original/vintage, no tags). |
| `src/ui.ts` | The phone shell: the card, **Posted on FB**, **Mark sold**, and the quick-add form that records condition and originality. |
| `test/ledger.test.ts` | The break test (same item bought on eBay and Etsy within 60 s → exactly one sale, one auto-cancel, no human), webhook idempotency, receipt-before-decrement, multi-tenant isolation. |
| `test/etsy.test.ts`, `test/etsy-webhook.test.ts`, `test/etsy-sold-sync.test.ts` | The Etsy day-one breakers: a forged webhook, a replayed one, a sale for a listing we do not know, original/vintage at write time, quota, and the cross-channel delist. |
| `test/facebook.test.ts`, `test/facebook-flow.test.ts` | The card rules and the two taps: posted-on-FB is a state, not a Facebook id; mark-sold ends every other listing; a second sale needs a refund. |
| `test/ebay-adapter.test.ts`, `test/ebay-consent.test.ts`, `test/ebay-consent-routes.test.ts`, `test/ebay-orders.test.ts`, `test/ebay-publish-route.test.ts`, `test/ebay-sync-route.test.ts` | The eBay day-one breakers: the three-call publish order, the offer that stayed in DRAFT, a callback replayed with somebody else's code, a sandbox token used against production, and a re-poll selling the same thing twice. |
| `test/photos.test.ts` | The photo rules: only plain file names, nothing outside the photos directory, and the absolute URL eBay downloads. |
| `test/publish-ui.test.ts` | The phone can actually publish: a button per marketplace, none for a marketplace that is not set up, and Etsy's rule applied before the button is offered. |
| `db/schema.sql` | Postgres schema. The same invariants as constraints: `UNIQUE (item_id, marketplace)` on listings, `UNIQUE (item_id)` on sales, `order_events` as the idempotency key. |
| `db/004_item_facts.sql` | The facts a card needs: `condition` and `original_or_vintage` on the item record. |
| `docs/architecture.md` | The five questions, the decisions, the deploy shape, what is still owner-gated. |

Not here yet: the Facebook post itself (never — Emily pastes the card herself). The eBay adapter
(0d) and its consent flow, sale sync and photo handling are in and proven against a fake eBay,
but they are unexercised against eBay until someone with an account connects it and the sandbox
keyset in PHA-5155 exists — the app refuses to pretend it is connected. The Etsy adapter and
the sold-sync are in (PHA-5096) on the same terms. Tracked on the PHATT TECH board as
PHA-5092 (0c), PHA-5093 (0d), PHA-5095 (1a), PHA-5096 (1b), PHA-5097 (1c), PHA-5094 (0e).

## Development

```bash
node --test test/*.test.ts     # no dependencies; Node 24 strips the types
```

The Postgres parity test in `test/store.test.ts` skips unless `STOOP_DATABASE_URL` is set, so it
never runs silently:

```bash
STOOP_DATABASE_URL=postgres://stoop:***@postgres/stoop_test node src/migrate.ts
STOOP_DATABASE_URL=postgres://stoop:***@postgres/stoop_test node --test test/*.test.ts
```

Secrets never live in this repo. OIDC credentials live on the host at
`/root/.openclaw/secrets/stoop-oidc.json` and, at deploy time, in the service's env file on vps1.

## Etsy (optional)

Without these the app still serves the Today screen and the Facebook card; it just cannot publish
to Etsy or receive its order-paid webhook.

| Variable | What it is |
|---|---|
| `STOOP_ETSY_API_KEY` | The app API key (also the OAuth `client_id`). Without it the Etsy side stays off. |
| `STOOP_ETSY_CLIENT_SECRET` | The OAuth client secret, if the app has one. |
| `STOOP_ETSY_WEBHOOK_SECRETS` | Signing secrets from the Etsy Webhook Portal, comma separated. One per endpoint. |
| `STOOP_ETSY_SHOP_ID` | The shop. Optional: it is looked up from the connected account. |
| `STOOP_ETSY_TAXONOMY_ID` | Default taxonomy id for a listing. Required to publish. |
| `STOOP_ETSY_SHIPPING_PROFILE_ID` | Default shipping profile for a physical listing. |
| `STOOP_ETSY_SCOPE` | Scopes for the consent screen. Default `listings_w listings_d transactions_r`. |
| `STOOP_ETSY_REDIRECT_URI` | Must be an https URL registered with Etsy. Default `<public url>/api/etsy/callback`. |
| `STOOP_ETSY_WHO_MADE` / `STOOP_ETSY_WHEN_MADE` | The default attribution. A per-item override wins. |

Emily connects her own account at `/api/etsy/connect` — the app never logs in for her. Access
tokens are refreshed automatically; a refresh token that has run out (about 90 days) shows up as
`etsy_reconsent_required` and needs her again.

## eBay (optional)

Without these the app still serves the Today screen and the Facebook card; it just cannot publish
to eBay or hear about an eBay sale.

| Variable | What it is |
|---|---|
| `STOOP_EBAY_CLIENT_ID` | The App ID. Without it the eBay side stays off. |
| `STOOP_EBAY_CLIENT_SECRET` | The Cert ID. |
| `STOOP_EBAY_ENV` | `sandbox` or `production`. Default `sandbox`. The two are different hosts with different sellers; the app never guesses. |
| `STOOP_EBAY_SCOPE` | The scope asked for on the consent screen. Default `https://api.ebay.com/oauth/api_scope`. |
| `STOOP_EBAY_MARKETPLACE_ID` | The marketplace id on every call (the header form, e.g. `0`). |
| `STOOP_EBAY_OFFER_MARKETPLACE` | The marketplace the offer body names (e.g. `EBAY_US`). Default `EBAY_US`. |
| `STOOP_EBAY_REDIRECT_URI` | Must be an https URL registered with eBay. Default `<public url>/api/ebay/callback`. |
| `STOOP_EBAY_INVENTORY_LOCATION_ID` | Where the seller's items live. **Required to publish.** eBay will not create an inventory item without it and it cannot be inferred. |
| `STOOP_EBAY_CATEGORY_ID` | The category items are listed in. **Required to publish.** |
| `STOOP_EBAY_FULFILLMENT_POLICY_ID` | The store's fulfillment policy. **Required to publish.** |
| `STOOP_EBAY_PAYMENT_POLICY_ID` | The store's payment policy. **Required to publish.** |
| `STOOP_EBAY_RETURN_POLICY_ID` | The store's return policy. **Required to publish.** |
| `STOOP_EBAY_SELLER_USER_ID` | The seller, when it is known. |
| `STOOP_PUBLIC_URL` | This app's public address. eBay downloads a listing photo by URL, so it has to be right. |

Emily connects her own account at `/api/ebay/connect` — the app never logs in for her. The
tokens are stored per environment, so a sandbox token can never be used against production. A
refresh token that has run out (about 180 days) shows up as `ebay_reconsent_required` and needs
her again.

Three things are enforced rather than assumed, because each one fails silently:

- the SKU is derived from Stoop's own item id, because a SKU has to be unique across the
  seller's whole inventory and two prints can share a title;
- the listing policies are applied in the same flow as the offer, and the offer is read back
  afterwards, because an offer without them sits in DRAFT and looks published from the outside;
- a sale is found by polling eBay's orders and joining them back through the seller SKU, because
  an eBay order names the inventory item and not Stoop's item.
