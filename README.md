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
| `src/sync.ts` | The remote action queue: the cross-channel delist is attempted, and left for a human when it fails. |
| `src/facebook.ts` | The Facebook paste card: the text Emily copies, the photos she has to attach herself, and the honesty rules (condition, original/vintage, no tags). |
| `src/ui.ts` | The phone shell: the card, **Posted on FB**, **Mark sold**, and the quick-add form that records condition and originality. |
| `test/ledger.test.ts` | The break test (same item bought on eBay and Etsy within 60 s → exactly one sale, one auto-cancel, no human), webhook idempotency, receipt-before-decrement, multi-tenant isolation. |
| `test/etsy.test.ts`, `test/etsy-webhook.test.ts`, `test/etsy-sold-sync.test.ts` | The Etsy day-one breakers: a forged webhook, a replayed one, a sale for a listing we do not know, original/vintage at write time, quota, and the cross-channel delist. |
| `test/facebook.test.ts`, `test/facebook-flow.test.ts` | The card rules and the two taps: posted-on-FB is a state, not a Facebook id; mark-sold ends every other listing; a second sale needs a refund. |
| `db/schema.sql` | Postgres schema. The same invariants as constraints: `UNIQUE (item_id, marketplace)` on listings, `UNIQUE (item_id)` on sales, `order_events` as the idempotency key. |
| `db/004_item_facts.sql` | The facts a card needs: `condition` and `original_or_vintage` on the item record. |
| `docs/architecture.md` | The five questions, the decisions, the deploy shape, what is still owner-gated. |

Not here yet: the eBay adapter (0d, blocked on the sandbox keyset in PHA-5155), the
Facebook post itself (never — Emily pastes the card herself). The Etsy adapter and the sold-sync
are in (PHA-5096), but they are unexercised against Etsy until someone with an account connects
it — the app refuses to pretend it is connected. Tracked on the PHATT TECH board as
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
