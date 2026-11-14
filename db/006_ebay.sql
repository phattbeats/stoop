-- Stoop — eBay seller tokens (PHA-5093)
--
-- Emily connects her own eBay seller account; the app never consents for her.
-- eBay's OAuth gives two tokens:
--
--   access_token   valid for about two hours. Cheap to refresh, useless
--                  without the refresh token.
--   refresh_token  valid for about 180 days and, once it is close to expiry,
--                  the app has to ask her to consent again.
--
-- The refresh deadline is stored rather than computed at read time, so the
-- app can ask Emily to re-consent *before* it breaks rather than discovering
-- it at 11pm on a Saturday.
--
-- The environment is part of the row, not a global: sandbox and production
-- are different sellers with different accounts, and a token from one must
-- never be used against the other.

CREATE TABLE ebay_tokens (
  seller_id          uuid PRIMARY KEY REFERENCES sellers(id) ON DELETE CASCADE,
  environment        text NOT NULL DEFAULT 'sandbox'
                       CHECK (environment IN ('sandbox','production')),
  seller_user_id     text,
  access_token       text NOT NULL,
  refresh_token      text NOT NULL,
  access_expires_at  timestamptz NOT NULL,
  refresh_expires_at timestamptz NOT NULL,
  scope              text NOT NULL DEFAULT '',
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- The environment is a lookup key: the app asks "which tokens do we have for
-- this seller in this environment", not "which tokens do we have".
CREATE INDEX ebay_tokens_env_idx ON ebay_tokens (environment, updated_at DESC);
