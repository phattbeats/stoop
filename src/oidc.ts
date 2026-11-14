/**
 * Stoop — PHATT ID (OIDC) client.
 *
 * The live issuer is vps1 Authentik at https://auth.phatt.vip/application/o/stoop/.
 * The RAID's `authentik-server` container is an alpine/socat mirror of vps1 —
 * it is a door, not the authority. Everything here talks to the issuer URL.
 *
 * Authorization code + PKCE. No implicit, no password grant, no long-lived
 * token kept by the app: the app mints its own short session after the code
 * exchange and forgets the tokens.
 */

import {
  createHash,
  createHmac,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify as cryptoVerify,
} from 'node:crypto';

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scope: string;
}

export interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
  code_challenge_methods_supported?: string[];
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export interface TokenResponse {
  access_token: string;
  id_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
}

export interface IdTokenClaims {
  iss: string;
  sub: string;
  aud?: string | string[];
  exp?: number;
  iat?: number;
  nonce?: string;
  name?: string;
  preferred_username?: string;
  email?: string;
  [claim: string]: unknown;
}

export interface Jwk {
  kid?: string;
  kty: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
  [field: string]: unknown;
}

function base64url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeSegment(segment: string): Buffer {
  return Buffer.from(segment.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/** PKCE S256 pair. The verifier never leaves the server. */
export function createPkce(): PkcePair {
  const verifier = base64url(randomBytes(48));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/** Random, unguessable state/nonce. */
export function randomToken(bytes = 24): string {
  return base64url(randomBytes(bytes));
}

export class OidcError extends Error {
  status?: number;
  body?: string;

  constructor(message: string, status?: number, body?: string) {
    super(message);
    this.name = 'OidcError';
    this.status = status;
    this.body = body;
  }
}

/** Fetch and cache the provider's discovery document. */
export class DiscoveryCache {
  private cached: Discovery | null = null;
  private fetchedAt = 0;

  private readonly issuer: string;
  private readonly ttlMs: number;

  constructor(issuer: string, ttlMs = 10 * 60 * 1000) {
    this.issuer = issuer;
    this.ttlMs = ttlMs;
  }

  async get(force = false): Promise<Discovery> {
    const now = Date.now();
    if (!force && this.cached && now - this.fetchedAt < this.ttlMs) return this.cached;
    const url = `${this.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
    const response = await fetch(url, { headers: { accept: 'application/json' } });
    if (!response.ok) {
      throw new OidcError(`discovery failed: ${response.status}`, response.status, await response.text());
    }
    const document = (await response.json()) as Discovery;
    if (!document.authorization_endpoint || !document.token_endpoint || !document.jwks_uri) {
      throw new OidcError('discovery document is missing required endpoints');
    }
    this.cached = document;
    this.fetchedAt = now;
    return document;
  }
}

export function buildAuthorizeUrl(
  discovery: Discovery,
  config: OidcConfig,
  params: { state: string; nonce: string; codeChallenge: string },
): string {
  const url = new URL(discovery.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('scope', config.scope);
  url.searchParams.set('state', params.state);
  url.searchParams.set('nonce', params.nonce);
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

/** Exchange an authorization code for tokens. Client authentication via HTTP Basic. */
export async function exchangeCode(
  discovery: Discovery,
  config: OidcConfig,
  params: { code: string; codeVerifier: string },
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: config.redirectUri,
    client_id: config.clientId,
    code_verifier: params.codeVerifier,
  });
  const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');

  let response = await fetch(discovery.token_endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${basic}`,
      accept: 'application/json',
    },
    body: body.toString(),
  });

  // Some deployments only accept client_secret_post.
  if (response.status === 401 || response.status === 400) {
    const first = await response.text();
    if (response.status === 401 && !first.includes('client_secret')) {
      throw new OidcError('token endpoint rejected client authentication', response.status, first);
    }
    response = await fetch(discovery.token_endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: params.code,
        redirect_uri: config.redirectUri,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code_verifier: params.codeVerifier,
      }).toString(),
    });
  }

  const text = await response.text();
  if (!response.ok) {
    throw new OidcError('token exchange failed', response.status, text);
  }
  return JSON.parse(text) as TokenResponse;
}

/** Fetch the signing keys for the issuer. */
export async function fetchJwks(discovery: Discovery): Promise<Jwk[]> {
  const response = await fetch(discovery.jwks_uri, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new OidcError(`jwks fetch failed: ${response.status}`, response.status);
  const body = (await response.json()) as { keys?: Jwk[] };
  return body.keys ?? [];
}

/**
 * Verify an id_token against the issuer.
 *
 * Two signatures are accepted, because this issuer uses both shapes:
 *   * RS256 — an RSA signing key published in the JWKS.
 *   * HS256 — a confidential client with no signing key configured; Authentik
 *     then MACs the token with the client secret (OIDC Core 3.1.3.7).
 *
 * `aud`, `iss`, `exp` and `nonce` are enforced in both cases: an id_token that
 * fails any of them is not a login.
 */
export function verifyIdToken(
  idToken: string,
  options: {
    jwks: Jwk[];
    issuer: string;
    clientId: string;
    clientSecret?: string;
    nonce?: string;
    now?: number;
  },
): IdTokenClaims {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new OidcError('id_token is malformed');
  const [headerPart, payloadPart, signaturePart] = parts;

  let header: { alg?: string; kid?: string };
  try {
    header = JSON.parse(decodeSegment(headerPart).toString('utf8'));
  } catch {
    throw new OidcError('id_token header is not JSON');
  }

  const signed = Buffer.from(`${headerPart}.${payloadPart}`);
  const signature = decodeSegment(signaturePart);

  if (header.alg === 'RS256') {
    const jwk = options.jwks.find((key) => (key.kid ? key.kid === header.kid : true));
    if (!jwk) throw new OidcError(`no jwk for kid ${header.kid ?? '(none)'}`);
    const publicKey = createPublicKey({ key: jwk as never, format: 'jwk' });
    if (!cryptoVerify('RSA-SHA256', signed, publicKey, signature)) {
      throw new OidcError('id_token signature is invalid');
    }
  } else if (header.alg === 'HS256') {
    if (!options.clientSecret) throw new OidcError('HS256 id_token but no client secret to verify it');
    const expected = createHmac('sha256', options.clientSecret).update(signed).digest();
    if (expected.length !== signature.length || !timingSafeEqual(expected, signature)) {
      throw new OidcError('id_token signature is invalid');
    }
  } else {
    throw new OidcError(`unsupported id_token alg: ${header.alg}`);
  }

  let claims: IdTokenClaims;
  try {
    claims = JSON.parse(decodeSegment(payloadPart).toString('utf8'));
  } catch {
    throw new OidcError('id_token payload is not JSON');
  }

  const now = Math.floor((options.now ?? Date.now()) / 1000);
  const expectedIssuer = options.issuer.replace(/\/$/, '');
  if (typeof claims.iss !== 'string' || claims.iss.replace(/\/$/, '') !== expectedIssuer) {
    throw new OidcError(`id_token issuer mismatch: ${claims.iss}`);
  }
  const audiences = Array.isArray(options.clientId)
    ? options.clientId
    : [options.clientId];
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.some((value) => value && audiences.includes(value))) {
    throw new OidcError('id_token audience mismatch');
  }
  if (typeof claims.exp !== 'number' || claims.exp <= now) throw new OidcError('id_token expired');
  if (typeof claims.nbf === 'number' && claims.nbf > now + 60) throw new OidcError('id_token not yet valid');
  if (typeof claims.iat === 'number' && claims.iat > now + 60) throw new OidcError('id_token issued in the future');
  if (options.nonce !== undefined && claims.nonce !== options.nonce) {
    throw new OidcError('id_token nonce mismatch');
  }
  if (typeof claims.sub !== 'string' || claims.sub.length === 0) {
    throw new OidcError('id_token has no subject');
  }
  return claims;
}

/** Ask the issuer who the user is. Used to fill in a display name. */
export async function fetchUserInfo(
  discovery: Discovery,
  accessToken: string,
): Promise<Record<string, unknown>> {
  const response = await fetch(discovery.userinfo_endpoint, {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
  });
  if (!response.ok) {
    throw new OidcError(`userinfo failed: ${response.status}`, response.status, await response.text());
  }
  return (await response.json()) as Record<string, unknown>;
}

/** Best available human name for a session. */
export function displayNameFromClaims(
  claims: IdTokenClaims,
  userInfo?: Record<string, unknown>,
): string {
  const candidates = [
    userInfo?.name,
    userInfo?.preferred_username,
    userInfo?.nickname,
    userInfo?.email,
    claims.name,
    claims.preferred_username,
    claims.email,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return 'PHATT ID';
}
