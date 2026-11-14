-- Stoop — canonical inventory ledger (Postgres)
--
-- One row per item. Marketplace listings are projections of that row.
-- The two constraints that carry the product:
--   * listings: UNIQUE (item_id, marketplace)  -> one listing per marketplace, revised in place
--   * sales:    UNIQUE (item_id)                -> exactly one recorded sale per item
-- A second real-world sale lands in duplicate_sales with needs_refund = true.

CREATE TABLE sellers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id  text NOT NULL UNIQUE,           -- Authentik (PHATT ID) subject
  display_name  text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id   uuid NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  title       text NOT NULL,
  description text NOT NULL DEFAULT '',
  price_cents integer NOT NULL CHECK (price_cents >= 0),
  photos      jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{url,width,height,bytes}]
  tags        text[] NOT NULL DEFAULT '{}',
  status      text NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft','published','sold','ended')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  sold_at     timestamptz
);

CREATE INDEX items_seller_idx ON items (seller_id, created_at DESC);

CREATE TABLE listings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id     uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  marketplace text NOT NULL CHECK (marketplace IN ('ebay','etsy','facebook')),
  remote_id   text,                              -- eBay offer id / Etsy listing id; null for the FB paste card
  state       text NOT NULL DEFAULT 'live'
                CHECK (state IN ('pending','live','ended')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  ended_at    timestamptz,
  end_reason  text,
  CONSTRAINT listings_item_marketplace_key UNIQUE (item_id, marketplace)
);

CREATE INDEX listings_live_idx ON listings (marketplace) WHERE state = 'live';

CREATE TABLE sales (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id      uuid NOT NULL UNIQUE REFERENCES items(id) ON DELETE CASCADE,
  marketplace  text NOT NULL CHECK (marketplace IN ('ebay','etsy','facebook')),
  order_id     text NOT NULL,
  amount_cents integer NOT NULL,
  occurred_at  timestamptz NOT NULL,
  receipt      jsonb NOT NULL,                   -- fetched from the marketplace before stock moved
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sales_marketplace_order_key UNIQUE (marketplace, order_id)
);

CREATE TABLE duplicate_sales (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id      uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  marketplace  text NOT NULL,
  order_id     text NOT NULL,
  amount_cents integer NOT NULL,
  occurred_at  timestamptz NOT NULL,
  receipt      jsonb NOT NULL,
  needs_refund boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT duplicate_sales_marketplace_order_key UNIQUE (marketplace, order_id)
);

-- Idempotency: the marketplace event id (Etsy webhook id) is the key.
CREATE TABLE order_events (
  event_id    text PRIMARY KEY,
  marketplace text NOT NULL,
  order_id    text NOT NULL,
  item_id     uuid REFERENCES items(id) ON DELETE SET NULL,
  outcome     text NOT NULL CHECK (outcome IN ('sale_recorded','suppressed_duplicate_sale','ignored_duplicate_webhook')),
  payload     jsonb,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE listing_events (
  id          bigserial PRIMARY KEY,
  listing_id  uuid NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  kind        text NOT NULL,                     -- published | revised | ended | cancel_requested | cancel_failed
  detail      jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
