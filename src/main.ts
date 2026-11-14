/**
 * Stoop — entrypoint.
 *
 * Wires the Postgres ledger, the PHATT ID login and the app's own short
 * session into the HTTP shell, then listens. Everything else is config.
 */

import { Pool } from 'pg';
import { AuthService } from './auth.ts';
import { loadConfig } from './config.ts';
import type { Ledger, Marketplace } from './ledger.ts';
import { migrate } from './migrate.ts';
import { createApp } from './server.ts';
import { SessionStore } from './session.ts';
import { PgLedger } from './store.ts';
import { PgDraftStore } from './drafts.ts';
import { AnthropicPathDrafter } from './llm.ts';
import { EtsyAdapter, EtsyClient } from './etsy.ts';
import { EBayAdapter } from './ebay.ts';
import { EBayClient } from './ebay-client.ts';
import { EtsyService } from './etsy-service.ts';
import type { EtsySaleLedger } from './etsy-service.ts';
import { EtsyTokenManager, PgEtsyTokenStore, PgRemoteActionStore } from './etsy-store.ts';
import { DelistRunner } from './sync.ts';
import type { MarketplaceAdapter } from './adapter.ts';

const config = loadConfig();

const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

if (process.env.STOOP_MIGRATE === '1') {
  await migrate(pool);
}

const sessions = new SessionStore(pool, config.sessionTtlMinutes);
const restored = await sessions.load();

const ledger = new PgLedger(pool);
const auth = new AuthService({ config, sessions });

// The drafter is optional: without a LiteLLM key the app still serves the
// Today screen, it just cannot propose listings.
const drafts = new PgDraftStore(pool);
const drafter = config.llmApiKey
  ? new AnthropicPathDrafter({
      baseUrl: config.llmBaseUrl,
      apiKey: config.llmApiKey,
      model: config.llmModel,
    })
  : undefined;

// ── Etsy (PHA-5096) ──────────────────────────────────────────────────────────
//
// Optional: without credentials the app still serves the Today screen and
// the Facebook card. Emily's Etsy account is hers to connect, so nothing
// here pretends to be connected until it really is.

const remoteActions = new PgRemoteActionStore(pool);
const adapters: Partial<Record<Marketplace, MarketplaceAdapter>> = {};
let etsyService: EtsyService | undefined;

// ── eBay (PHA-5093) ──────────────────────────────────────────────────────────
//
// Optional, like Etsy: without credentials the app still serves the Today
// screen and the Facebook card. Nothing here pretends to be connected until
// it really is — the adapter refuses to publish without the inventory
// location, category and store policies, so a half-configured keyset fails
// loudly instead of creating offers that never go live.

if (config.ebay) {
  const client = new EBayClient({
    clientId: config.ebay.clientId,
    clientSecret: config.ebay.clientSecret,
    environment: config.ebay.environment,
    scope: config.ebay.scope,
    marketplaceId: config.ebay.marketplaceId,
    ...(config.ebay.refreshToken ? { refreshToken: config.ebay.refreshToken } : {}),
  });
  const adapter = new EBayAdapter(
    client,
    { accessToken: () => client.accessToken() },
    {
      inventoryLocationId: config.ebay.inventoryLocationId ?? '',
      categoryId: config.ebay.categoryId ?? '',
      fulfillmentPolicyId: config.ebay.fulfillmentPolicyId ?? '',
      paymentPolicyId: config.ebay.paymentPolicyId ?? '',
      returnPolicyId: config.ebay.returnPolicyId ?? '',
    },
  );
  adapters.ebay = adapter;
}

if (config.etsy) {
  const client = new EtsyClient({
    apiKey: config.etsy.apiKey,
    clientSecret: config.etsy.clientSecret,
  });
  const tokenStore = new PgEtsyTokenStore(pool);
  const tokenManager = new EtsyTokenManager(client, tokenStore);
  const adapter = new EtsyAdapter(
    client,
    tokenManager,
    {
      shopId: config.etsy.shopId || (async () => (await tokenStore.first())?.shopId ?? ''),
      ...(config.etsy.taxonomyId ? { defaultTaxonomyId: config.etsy.taxonomyId } : {}),
      ...(config.etsy.shippingProfileId ? { defaultShippingProfileId: config.etsy.shippingProfileId } : {}),
      defaultWhoMade: config.etsy.whoMade,
      defaultWhenMade: config.etsy.whenMade,
    },
  );
  adapters.etsy = adapter;

  const delist = new DelistRunner(remoteActions, adapters);
  etsyService = new EtsyService(
    {
      client,
      adapter,
      tokenStore,
      tokenManager,
      webhookSecrets: config.etsy.webhookSecrets,
      shopId: config.etsy.shopId,
      taxonomyId: config.etsy.taxonomyId,
      shippingProfileId: config.etsy.shippingProfileId,
      whoMade: config.etsy.whoMade,
      whenMade: config.etsy.whenMade,
      scope: config.etsy.scope,
      redirectUri: config.etsy.redirectUri,
    },
    ledger as unknown as EtsySaleLedger,
    delist,
  );
}

const { server } = createApp({
  // The Postgres store implements the same contract as the in-memory ledger.
  ledger: ledger as unknown as Ledger,
  verifySession: (token) => sessions.verify(token),
  drafts,
  ...(drafter ? { drafter } : {}),
  photosDir: config.photosDir,
  ...(etsyService ? { etsy: etsyService } : {}),
  ...(adapters.ebay ? { ebay: adapters.ebay } : {}),
  remoteActions,
  delist: new DelistRunner(remoteActions, adapters),
  sessionSecret: config.sessionSecret,
  auth: {
    begin: () => auth.begin(),
    complete: (params) => auth.complete(params),
    logout: (token) => auth.logout(token),
  },
});

server.listen(config.port, '0.0.0.0', () => {
  console.log(
    `stoop listening on :${config.port} issuer=${config.issuer} sessions=${restored}`,
  );
});

const shutdown = async (signal: string) => {
  console.log(`${signal}: closing`);
  server.close();
  await pool.end().catch(() => undefined);
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

// Expired sessions are cheap to reap; do it on a slow timer.
const prune = setInterval(() => {
  void sessions.prune().catch(() => undefined);
}, 15 * 60 * 1000);
prune.unref();
