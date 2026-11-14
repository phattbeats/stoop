/**
 * Stoop — the eBay service.
 *
 * The adapter knows how to publish; this knows how a seller connects. The
 * two are separate because connecting is a *human* act: Emily consents to
 * eBay's screen herself, in her own browser, with her own account. Nothing
 * in this file consents for her, and nothing here pretends an account is
 * connected until eBay has actually returned a token.
 *
 * The environment is explicit at every step. Sandbox and production are
 * different hosts, different sellers and different accounts, and the tokens
 * are stored per environment so a sandbox token can never be used to publish
 * into production.
 */

import { EBayAdapter, type EBayAdapterOptions } from './ebay.ts';
import {
  EBayClient,
  EBayPolicyError,
  type EBayEnvironment,
  type EBayTokens,
} from './ebay-client.ts';
import type { EBayTokenStore } from './ebay-store.ts';

export interface EBayServiceOptions {
  client: EBayClient;
  adapter: EBayAdapter;
  tokenStore: EBayTokenStore;
  environment: EBayEnvironment;
  redirectUri: string;
  scope?: string;
  /** Where the seller's items live. eBay will not offer anything without it. */
  inventoryLocationId?: string;
  categoryId?: string;
  fulfillmentPolicyId?: string;
  paymentPolicyId?: string;
  returnPolicyId?: string;
  marketplace?: string;
}

export class EBayService {
  private readonly options: EBayServiceOptions;

  constructor(options: EBayServiceOptions) {
    this.options = options;
  }

  /**
   * The URL Emily is sent to so *she* consents.
   *
   * PKCE with S256, a state that has to come back unchanged, and the scope
   * the Sell Inventory API needs. An agent never consents for her.
   */
  authorizationUrl(state: string, codeChallenge: string): string {
    return this.options.client.authorizationUrl({
      redirectUri: this.options.redirectUri,
      scope: this.options.scope,
      state,
      codeChallenge,
    });
  }

  /**
   * Exchange the code, keep the tokens.
   *
   * The seller user id comes back from eBay's identity service, not from the
   * token response, so it is fetched with the token that was just minted. If
   * that lookup fails the tokens are still saved — losing the id is not worth
   * making Emily consent twice.
   */
  async completeAuthorization(
    sellerId: string,
    code: string,
    codeVerifier: string,
  ): Promise<{ sellerUserId?: string }> {
    const tokens: EBayTokens = await this.options.client.exchangeCode({
      code,
      codeVerifier,
      redirectUri: this.options.redirectUri,
    });

    let sellerUserId: string | undefined;
    try {
      sellerUserId = await this.options.client.sellerUserId(tokens.accessToken);
    } catch {
      // Not fatal: the tokens work without it.
    }

    await this.options.tokenStore.save(sellerId, this.options.environment, {
      ...tokens,
      ...(sellerUserId ? { sellerUserId } : {}),
    });

    return sellerUserId ? { sellerUserId } : {};
  }

  /** Is a seller connected in this environment? Used by the Today screen. */
  async isConnected(sellerId: string): Promise<boolean> {
    const stored = await this.options.tokenStore.get(sellerId, this.options.environment);
    return Boolean(stored);
  }

  /** The adapter, for the publish and delist paths. */
  get adapter(): EBayAdapter {
    return this.options.adapter;
  }
}

/**
 * Build the adapter for a service.
 *
 * Kept separate so the adapter and the service cannot drift apart on the
 * store's policies: the service is the only place that knows which
 * environment it is talking to, and the adapter is the only place that knows
 * how to publish.
 */
export function buildEBayAdapter(
  client: EBayClient,
  tokens: { accessToken(): Promise<string> },
  options: EBayAdapterOptions,
): EBayAdapter {
  if (!options.inventoryLocationId) {
    // Not fatal at construction: the app still serves the Today screen and
    // the Facebook card. The adapter refuses at publish time, loudly.
  }
  return new EBayAdapter(client, tokens, options);
}

export { EBayPolicyError };
