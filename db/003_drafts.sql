-- Stoop — listing drafts (PHA-5095)
--
-- A draft is a proposal that Emily has not approved yet. It is deliberately
-- its own table: an approved draft becomes an item, but an unapproved one is
-- just a suggestion and must never look like inventory.

CREATE TABLE listing_drafts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id           uuid NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  item_id             uuid REFERENCES items(id) ON DELETE SET NULL,
  status              text NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft','approved','rejected')),
  title               text NOT NULL,
  description         text NOT NULL DEFAULT '',
  tags                text[] NOT NULL DEFAULT '{}',
  price_low_cents     integer NOT NULL CHECK (price_low_cents >= 0),
  price_high_cents    integer NOT NULL CHECK (price_high_cents >= 0),
  shipping            jsonb NOT NULL DEFAULT '[]'::jsonb,
  photos              jsonb NOT NULL DEFAULT '[]'::jsonb,
  notes               text NOT NULL DEFAULT '',
  original_or_vintage boolean,
  condition           text NOT NULL DEFAULT 'unspecified',
  confidence          real NOT NULL DEFAULT 0.5,
  flags               text[] NOT NULL DEFAULT '{}',
  created_at          timestamptz NOT NULL DEFAULT now(),
  decided_at          timestamptz
);

CREATE INDEX listing_drafts_seller_idx ON listing_drafts (seller_id, created_at DESC);

-- One live draft per seller at a time is not a rule we want to enforce: Emily
-- may photograph three things before she looks at the first. Decided drafts
-- keep their decision: the record of what she approved does not change.
