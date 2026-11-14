# Stoop

Emily's one-record listing app. Photograph an item, approve the AI draft, publish to eBay and
Etsy, paste a card into Facebook Marketplace. One inventory record per item; a sale anywhere
ends the other listings.

PHATT ID (Authentik) login. No browser automation against Emily's accounts.

## What is here right now

| Path | What |
|---|---|
| `src/ledger.ts` | The canonical inventory ledger: one record per item, one listing per marketplace, one sale per item, auto-cancel on sale. The domain rules the product lives on. |
| `test/ledger.test.ts` | The break test (same item bought on eBay and Etsy within 60 s → exactly one sale, one auto-cancel, no human), webhook idempotency, receipt-before-decrement, multi-tenant isolation. |
| `db/schema.sql` | Postgres schema. The same invariants as constraints: `UNIQUE (item_id, marketplace)` on listings, `UNIQUE (item_id)` on sales, `order_events` as the idempotency key. |
| `docs/architecture.md` | The five questions, the decisions, the deploy shape, what is still owner-gated. |

Not here yet: the phone shell, the eBay/Etsy adapters, the drafter, the Facebook paste card.
Tracked on the PHATT TECH board as PHA-5092 (0c), PHA-5093 (0d), PHA-5095 (1a), PHA-5096 (1b),
PHA-5097 (1c), PHA-5094 (0e).

## Development

```bash
node --test test/*.test.ts     # no dependencies; Node 24 strips the types
```

Secrets never live in this repo. OIDC credentials live on the host at
`/root/.openclaw/secrets/stoop-oidc.json` and, at deploy time, in the service's env file on vps1.
