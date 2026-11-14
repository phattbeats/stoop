# Stoop

Emily's one-record listing app. Photograph an item, approve the AI draft, publish to eBay and
Etsy, paste a card into Facebook Marketplace. One inventory record per item; a sale anywhere
ends the other listings.

PHATT ID (Authentik) login. No browser automation against Emily's accounts.

## What is here right now

| Path | What |
|---|---|
| `src/ledger.ts` | The canonical inventory ledger: one record per item, one listing per marketplace, one sale per item, auto-cancel on sale. The domain rules the product lives on. |
| `src/facebook.ts` | The Facebook paste card: the text Emily copies, the photos she has to attach herself, and the honesty rules (condition, original/vintage, no tags). |
| `src/ui.ts` | The phone shell: the card, **Posted on FB**, **Mark sold**, and the quick-add form that records condition and originality. |
| `test/ledger.test.ts` | The break test (same item bought on eBay and Etsy within 60 s → exactly one sale, one auto-cancel, no human), webhook idempotency, receipt-before-decrement, multi-tenant isolation. |
| `test/facebook.test.ts`, `test/facebook-flow.test.ts` | The card rules and the two taps: posted-on-FB is a state, not a Facebook id; mark-sold ends every other listing; a second sale needs a refund. |
| `db/schema.sql` | Postgres schema. The same invariants as constraints: `UNIQUE (item_id, marketplace)` on listings, `UNIQUE (item_id)` on sales, `order_events` as the idempotency key. |
| `db/004_item_facts.sql` | The facts a card needs: `condition` and `original_or_vintage` on the item record. |
| `docs/architecture.md` | The five questions, the decisions, the deploy shape, what is still owner-gated. |

Not here yet: the eBay/Etsy adapters (0d, blocked on the sandbox keyset in PHA-5155), the
Facebook post itself (never — Emily pastes the card herself). Tracked on the PHATT TECH board as
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
