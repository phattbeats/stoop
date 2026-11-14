/**
 * Stoop — the eBay transport and OAuth client.
 *
 * This file is the plumbing, not the adapter. It exists because the parts that
 * do NOT need a credential should not wait for one:
 *
 *   * the OAuth2 token exchange against eBay's identity service
 *     (client-credentials for an app token, authorization-code + PKCE for a
 *     seller, refresh-token grant to keep one alive);
 *   * one HTTP transport that attaches the bearer, carries the marketplace
 *     header eBay requires on every call, honours `Retry-After` on a 429, and
 *     replays a request once after refreshing an expired token.
 *
 * The rules this file enforces that a UI cannot:
 *   * the environment is explicit. Sandbox and production are different hosts
 *     with different sellers; a client that guessed wrong would publish Emily's
 *     one-off into a sandbox nobody reads, or the reverse.
 *   * eBay's identity service authenticates the app with HTTP Basic
 *     (client id and secret base64'd together), not with form fields.
 *   * a 401 is a stale token, not a broken request: refresh once, replay
 *     once, and never loop.
 *
 * What is deliberately NOT here: the offer. Publishing is the Sell Inventory
 * API (`createInventoryItem` → `createOffer` → listing policies), and the
 * exact request shape — especially the payment / fulfillment / return policy
 * fields — is written against a real sandbox contract, not from memory. The
 * adapter (`src/ebay.ts`) lands with it.
 *
 * Endpoint shapes:
 *   POST  {identity}/identity/v1/oauth2/token
 *   GET   {identity}/identity/v1/oauth2/authorize
 *   *     {api}/…            with `X-EBAY-C-MARKETPLACE-ID` on every call
 */

export type EBayEnvironment = 'sandbox' | 'production';

export interface EBayEndpoints {
  /** The API host: sell, buy and inventory calls live here. */
  api: string;
  /** The OAuth token endpoint. */
  token: string;
  /** The consent screen. Emily is sent here; an agent never consents for her. */
  authorize: string;
}

export const EBAY_ENDPOINTS: Record<EBayEnvironment, EBayEndpoints> = {
  sandbox: {
    api: 'https://api.sandbox.ebay.com',
    token: 'https://api.sandbox.ebay.com/identity/v1/oauth2/token',
    authorize: 'https://api.sandbox.ebay.com/identity/v1/oauth2/authorize',
  },
  production: {
    api: 'https://api.ebay.com',
    token: 'https://api.ebay.com/identity/v1/oauth2/token',
    authorize: 'https://api.ebay.com/identity/v1/oauth2/authorize',
  },
};

/** eBay's scopes are URLs, and this is the one that reaches the sell APIs. */
export const EBAY_DEFAULT_SCOPE = 'https://api.ebay.com/oauth/api_scope';

/** eBay's marketplace ids. The US marketplace is the default. */
export const EBAY_MARKETPLACE = {
  US: 'EBAY_US',
  M_US: '0',
  GB: '3',
  DE: '77',
} as const;

/** Seconds of skew subtracted from the token lifetime before it is reused. */
const TOKEN_EXPIRY_SKEW_SECONDS = 60;

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class EBayError extends Error {
  readonly status: number;
  readonly body: string;
  /** True when the same request might succeed later, without a change. */
  readonly retryable: boolean;

  constructor(message: string, status: number, body = '', retryable = false) {
    super(message);
    this.name = 'EBayError';
    this.status = status;
    this.body = body;
    this.retryable = retryable;
  }
}

/** The request cannot be made right, no matter how often it is repeated. */
export class EBayPolicyError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'EBayPolicyError';
    this.code = code;
  }
}

export interface EBayTokens {
  accessToken: string;
  tokenType: string;
  /** Seconds until the access token expires. */
  expiresIn: number;
  /** Only the authorization-code grant returns one. */
  refreshToken?: string;
  /** The scope eBay says the token actually carries. */
  scope?: string;
}

export interface EBayClientOptions {
  /** The app's client id (eBay calls it the App ID / client id). */
  clientId: string;
  /** The app's client secret (eBay calls it the Cert ID / client secret). */
  clientSecret: string;
  /** Which eBay this client talks to. Defaults to the sandbox. */
  environment?: EBayEnvironment;
  /** The scope requested with a seller token. */
  scope?: string;
  /** The marketplace id sent on every API call. */
  marketplaceId?: string;
  /** A seller's refresh token, when there is one. Enables refresh-on-401. */
  refreshToken?: string;
  baseUrl?: string;
  tokenUrl?: string;
  authorizeUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  /** How many times a 429 or a 5xx is retried before it is given up on. */
  maxRetries?: number;
}

export interface EBayRequestOptions {
  method?: string;
  body?: string | Buffer;
  contentType?: string;
  /** Extra headers, applied last. */
  headers?: Record<string, string>;
  /** Use this token instead of the client's own. */
  token?: string;
}

/** eBay's error payload: { errors: [{ errorId, message, severity }] }. */
export function readEbayErrorMessage(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const errors = (payload as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) return undefined;
  const first = errors[0] as { message?: unknown } | undefined;
  return typeof first?.message === 'string' ? first.message : undefined;
}

export class EBayClient {
  private readonly options: EBayClientOptions;
  private cached?: { value: string; expiresAt: number };
  private refreshInFlight?: Promise<string>;

  constructor(options: EBayClientOptions) {
    this.options = options;
  }

  private get environment(): EBayEnvironment {
    return this.options.environment ?? 'sandbox';
  }

  private get endpoints(): EBayEndpoints {
    return EBAY_ENDPOINTS[this.environment];
  }

  private get baseUrl(): string {
    return (this.options.baseUrl ?? this.endpoints.api).replace(/\/$/, '');
  }

  private get tokenUrl(): string {
    return this.options.tokenUrl ?? this.endpoints.token;
  }

  private get authorizeUrl(): string {
    return this.options.authorizeUrl ?? this.endpoints.authorize;
  }

  private get scope(): string {
    return this.options.scope ?? EBAY_DEFAULT_SCOPE;
  }

  private get fetchImpl(): typeof fetch {
    return this.options.fetchImpl ?? fetch;
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  private async sleep(ms: number): Promise<void> {
    await (this.options.sleep ?? defaultSleep)(ms);
  }

  /**
   * The URL Emily is sent to so *she* consents. Agents never consent for her.
   */
  authorizationUrl(params: { redirectUri: string; state: string; codeChallenge: string; scope?: string }): string {
    const url = new URL(this.authorizeUrl);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.options.clientId);
    url.searchParams.set('redirect_uri', params.redirectUri);
    url.searchParams.set('scope', params.scope ?? this.scope);
    url.searchParams.set('state', params.state);
    url.searchParams.set('code_challenge', params.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return url.toString();
  }

  /** Exchange an authorization code for a seller token and a refresh token. */
  async exchangeCode(params: { code: string; codeVerifier: string; redirectUri: string }): Promise<EBayTokens> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: params.code,
      code_verifier: params.codeVerifier,
      redirect_uri: params.redirectUri,
    });
    return this.requestTokens(body);
  }

  /**
   * Trade a refresh token for a new access token.
   *
   * eBay's refresh token outlives the access token by months, so a failure
   * here means "the seller has to consent again", not "retry harder".
   */
  async refreshAccessToken(refreshToken: string): Promise<EBayTokens> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
    const tokens = await this.requestTokens(body);
    return { ...tokens, refreshToken: tokens.refreshToken ?? refreshToken };
  }

  /** An app-level token: the client on its own, with no seller behind it. */
  async clientCredentialsToken(scope?: string): Promise<EBayTokens> {
    const body = new URLSearchParams({ grant_type: 'client_credentials' });
    if (scope) body.set('scope', scope);
    return this.requestTokens(body);
  }

  /**
   * The seller behind a token.
   *
   * eBay's identity service answers with the user id, and it is the only
   * place that knows it — the token response does not carry it. The call
   * needs its own scope, because the seller's own token is scoped to the
   * Sell APIs, not to identity.
   */
  async sellerUserId(accessToken: string): Promise<string | undefined> {
    const response = await this.fetchImpl(`${this.baseUrl}/identity/v1/userinfo`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'application/json',
        'x-ebay-c-marketplace-id': this.options.marketplaceId ?? EBAY_MARKETPLACE.M_US,
      },
    });
    if (!response.ok) {
      throw new EBayError(
        `ebay could not identify the seller (${response.status})`,
        response.status,
        (await response.text()).slice(0, 400),
      );
    }
    const payload = (await response.json()) as Record<string, unknown>;
    const id = payload.user_id ?? payload.username;
    return id ? String(id) : undefined;
  }

  /**
   * A usable access token.
   *
   * A seller token is preferred (it is the one that can publish); an app token
   * is the fallback. The token is cached until shortly before it expires.
   */
  async accessToken(): Promise<string> {
    const cached = this.cached;
    if (cached && cached.expiresAt > this.now()) return cached.value;

    if (this.refreshInFlight) return this.refreshInFlight;

    const pending = (async () => {
      const tokens = this.options.refreshToken
        ? await this.refreshAccessToken(this.options.refreshToken)
        : await this.clientCredentialsToken(this.scope);
      this.remember(tokens.accessToken, tokens.expiresIn);
      return tokens.accessToken;
    })();
    this.refreshInFlight = pending;
    try {
      return await pending;
    } finally {
      this.refreshInFlight = undefined;
    }
  }

  /** Forget the cached token — used when eBay says 401 and we have to replay. */
  invalidateToken(): void {
    this.cached = undefined;
  }

  /**
   * One API call.
   *
   * A 401 is answered exactly once: the token is refreshed and the request is
   * replayed. Two 401s is a real failure and is reported as one.
   */
  async request(path: string, init: EBayRequestOptions = {}): Promise<any> {
    const token = init.token ?? (await this.accessToken());
    try {
      return await this.send(path, init, token);
    } catch (error) {
      if (error instanceof EBayError && error.status === 401 && !init.token && this.options.refreshToken) {
        this.invalidateToken();
        const fresh = await this.accessToken();
        return this.send(path, init, fresh);
      }
      throw error;
    }
  }

  private remember(value: string, expiresIn: number): void {
    const lifetime = Math.max(0, Number(expiresIn) - TOKEN_EXPIRY_SKEW_SECONDS);
    this.cached = { value, expiresAt: this.now() + lifetime * 1000 };
  }

  private async send(path: string, init: EBayRequestOptions, token: string): Promise<any> {
    const maxRetries = this.options.maxRetries ?? 2;
    let attempt = 0;

    for (;;) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 20_000);
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method: init.method ?? 'GET',
          headers: {
            authorization: `Bearer ${token}`,
            accept: 'application/json',
            'x-ebay-c-marketplace-id': this.options.marketplaceId ?? EBAY_MARKETPLACE.M_US,
            ...(init.body === undefined
              ? {}
              : { 'content-type': init.contentType ?? 'application/json' }),
            ...(init.headers ?? {}),
          },
          ...(init.body === undefined ? {} : { body: init.body as BodyInit }),
          signal: controller.signal,
        });
      } catch (error) {
        clearTimeout(timeout);
        throw new EBayError(
          `ebay could not be reached: ${String((error as Error).message ?? error)}`,
          0,
          '',
          true,
        );
      }
      clearTimeout(timeout);

      if ((response.status === 429 || response.status >= 500) && attempt < maxRetries) {
        attempt += 1;
        const retryAfter = Number(response.headers.get('retry-after') ?? '0');
        await this.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000);
        continue;
      }

      const text = await response.text();
      if (!response.ok) {
        let message = `ebay returned ${response.status}`;
        try {
          const parsed = JSON.parse(text) as unknown;
          message = readEbayErrorMessage(parsed) ?? message;
        } catch {
          // Not JSON. The status line is all we have.
        }
        throw new EBayError(
          message,
          response.status,
          text.slice(0, 600),
          response.status === 429 || response.status >= 500,
        );
      }
      if (!text) return {};
      try {
        return JSON.parse(text);
      } catch {
        throw new EBayError('ebay returned a non-JSON response', response.status, text.slice(0, 400));
      }
    }
  }

  /**
   * The token call itself.
   *
   * eBay's identity service wants the app's credentials as HTTP Basic, and
   * the grant as a form body. The two are not interchangeable, and sending the
   * secret as a form field is how a credential ends up in a log.
   */
  private async requestTokens(body: URLSearchParams): Promise<EBayTokens> {
    const basic = Buffer.from(`${this.options.clientId}:${this.options.clientSecret}`).toString('base64');
    const response = await this.fetchImpl(this.tokenUrl, {
      method: 'POST',
      headers: {
        authorization: `Basic ${basic}`,
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: body.toString(),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new EBayError(`ebay refused the token request (${response.status})`, response.status, text.slice(0, 400));
    }
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new EBayError('ebay returned a non-JSON token response', response.status, text.slice(0, 400));
    }
    const accessToken = String(payload.access_token ?? '');
    if (!accessToken) {
      throw new EBayError('ebay returned no access token', response.status, text.slice(0, 400));
    }
    const tokens: EBayTokens = {
      accessToken,
      tokenType: String(payload.token_type ?? 'Bearer'),
      expiresIn: Number(payload.expires_in ?? 7200),
    };
    if (typeof payload.refresh_token === 'string' && payload.refresh_token) tokens.refreshToken = payload.refresh_token;
    if (typeof payload.scope === 'string' && payload.scope) tokens.scope = payload.scope;
    return tokens;
  }
}
