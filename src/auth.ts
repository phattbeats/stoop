/**
 * Stoop — PHATT ID login.
 *
 * The browser leaves for the issuer, comes back with a code, and the app mints
 * its own short session. The authorization tokens never leave the server and
 * are not kept: after the exchange, all that survives is who the user is and
 * an opaque session token.
 */

import type { Config } from './config.ts';
import {
  DiscoveryCache,
  buildAuthorizeUrl,
  createPkce,
  displayNameFromClaims,
  exchangeCode,
  fetchJwks,
  fetchUserInfo,
  randomToken,
  verifyIdToken,
  type Discovery,
} from './oidc.ts';
import { decodeLoginState, encodeLoginState, type SessionStore } from './session.ts';

export interface AuthServiceOptions {
  config: Config;
  sessions: SessionStore;
  discovery?: DiscoveryCache;
}

export interface BeginResult {
  url: string;
  cookie: string;
}

export interface CompleteResult {
  token: string;
  maxAgeSeconds: number;
}

export class AuthService {
  private readonly discovery: DiscoveryCache;

  private readonly options: AuthServiceOptions;

  constructor(options: AuthServiceOptions) {
    this.options = options;
    this.discovery = options.discovery ?? new DiscoveryCache(options.config.issuer);
  }

  /** Start a login: PKCE, state, nonce, and the URL to send the browser to. */
  async begin(): Promise<BeginResult> {
    const discovery = await this.discovery.get();
    const pkce = createPkce();
    const state = randomToken();
    const nonce = randomToken();
    const url = buildAuthorizeUrl(discovery, this.options.config, {
      state,
      nonce,
      codeChallenge: pkce.challenge,
    });
    const cookie = encodeLoginState(
      { state, nonce, verifier: pkce.verifier, ts: Date.now() },
      this.options.config.sessionSecret,
    );
    return { url, cookie };
  }

  /** Finish a login: exchange the code, verify the id_token, mint a session. */
  async complete(params: {
    code: string;
    state: string;
    cookie: string | null;
  }): Promise<CompleteResult | null> {
    if (!params.code) return null;
    const loginState = decodeLoginState(params.cookie ?? undefined, this.options.config.sessionSecret);
    if (!loginState) return null;
    if (loginState.state !== params.state) return null;

    const discovery: Discovery = await this.discovery.get();
    const tokens = await exchangeCode(discovery, this.options.config, {
      code: params.code,
      codeVerifier: loginState.verifier,
    });
    if (!tokens.id_token) throw new Error('issuer returned no id_token');

    const jwks = await fetchJwks(discovery);
    const claims = verifyIdToken(tokens.id_token, {
      jwks,
      issuer: discovery.issuer,
      clientId: this.options.config.clientId,
      clientSecret: this.options.config.clientSecret,
      nonce: loginState.nonce,
    });

    let userInfo: Record<string, unknown> | undefined;
    try {
      userInfo = await fetchUserInfo(discovery, tokens.access_token);
    } catch {
      userInfo = undefined;
    }

    const displayName = displayNameFromClaims(claims, userInfo);
    const { token, record } = await this.options.sessions.create(claims.sub, displayName);
    return {
      token,
      maxAgeSeconds: Math.max(
        1,
        Math.floor((record.expiresAt.getTime() - Date.now()) / 1000),
      ),
    };
  }

  /** Sign out. The IdP session is left alone; the app's session is not. */
  async logout(sessionToken: string | null): Promise<void> {
    if (!sessionToken) return;
    await this.options.sessions.revoke(sessionToken);
  }
}
