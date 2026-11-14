-- Stoop — the facts a card needs (PHA-5097)
--
-- The Facebook paste card has to be honest about what the item is, and the
-- item record is where that truth lives: Etsy is original/vintage only, and
-- the card may never round a "made by someone else" item up to "vintage".
--
-- Additive and safe. Existing rows get 'unspecified' (nobody has said) and
-- NULL (not asserted either way). Nothing is back-filled with a guess.

ALTER TABLE items ADD COLUMN IF NOT EXISTS condition text NOT NULL DEFAULT 'unspecified';
ALTER TABLE items ADD COLUMN IF NOT EXISTS original_or_vintage boolean;
