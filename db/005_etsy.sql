-- Stoop — Etsy tokens and the remote action queue (PHA-5096)
--
-- Two tables, two jobs:
--
--   etsy_tokens     Etsy's OAuth tokens for the one shop we sell through.
--                   Access tokens live an hour; refresh tokens have a ~90 day
--                   functional lifetime, so the refresh deadline is stored so
--                   the app can ask Emily to re-consent *before* it breaks.
--
--   remote_actions  The cross-channel delist queue. A sale ends every other
--                   listing, but a remote delist is a network call that can
--                   fail, and pretending it is atomic is how you sell one
--                   painting twice. The sale is recorded first; the remote
--                   ending is queued, attempted, and if it fails it is left
--                   visible for a human.

CREATE TABLE etsy_tokens (
  seller_id         uuid PRIMARY KEY REFERENCES sellers(id) ON DELETE CASCADE,
  shop_id           bigint,
  access_token      text NOT NULL,
  refresh_token     text NOT NULL,
  access_expires_at timestamptz NOT NULL,
  refresh_expires_at timestamptz NOT NULL,
  scope             text NOT NULL DEFAULT '',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- The webhook names the shop, not the seller. This is how a delivery finds
-- the tokens it needs.
CREATE INDEX etsy_tokens_shop_idx ON etsy_tokens (shop_id);

CREATE TABLE remote_actions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dedupe_key   text NOT NULL UNIQUE,
  item_id      uuid REFERENCES items(id) ON DELETE CASCADE,
  listing_id   uuid REFERENCES listings(id) ON DELETE SET NULL,
  marketplace  text NOT NULL,
  action       text NOT NULL CHECK (action IN ('delist','review')),
  remote_id    text,
  state        text NOT NULL DEFAULT 'pending'
                 CHECK (state IN ('pending','succeeded','failed','needs_human')),
  needs_human  boolean NOT NULL DEFAULT false,
  attempts     integer NOT NULL DEFAULT 0,
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX remote_actions_open_idx ON remote_actions (state, created_at)
  WHERE state IN ('pending','failed','needs_human');
