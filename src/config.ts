/**
 * Stoop — runtime configuration.
 *
 * Everything the app needs comes from the environment. Secrets are never in
 * the repo; the deploy writes them into the service's env file on vps1.
 */

export interface Config {
  port: number;
  publicUrl: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scope: string;
  databaseUrl: string;
  /** The app keeps its own short session; this is how short. */
  sessionTtlMinutes: number;
  /** HMAC key for the short-lived login-state cookie. */
  sessionSecret: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env: ${name}`);
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const publicUrl = optional('STOOP_PUBLIC_URL', 'https://stoop.phatt.vip').replace(/\/$/, '');
  const issuer = optional('STOOP_ISSUER', 'https://auth.phatt.vip/application/o/stoop/');
  const scope = optional('STOOP_SCOPE', 'openid profile');
  return {
    port: Number(optional('STOOP_PORT', '3000')),
    publicUrl,
    issuer,
    clientId: required('STOOP_CLIENT_ID'),
    clientSecret: required('STOOP_CLIENT_SECRET'),
    redirectUri: optional('STOOP_REDIRECT_URI', `${publicUrl}/auth/callback`),
    scope,
    databaseUrl: required('STOOP_DATABASE_URL'),
    sessionTtlMinutes: Number(optional('STOOP_SESSION_TTL_MINUTES', '480')),
    sessionSecret: required('STOOP_SESSION_SECRET'),
  };
}
