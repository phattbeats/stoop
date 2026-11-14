import assert from 'node:assert/strict';
import { createHash, createSign, generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import {
  buildAuthorizeUrl,
  createPkce,
  displayNameFromClaims,
  randomToken,
  verifyIdToken,
  type Discovery,
  type IdTokenClaims,
  type Jwk,
} from '../src/oidc.ts';

const discovery: Discovery = {
  issuer: 'https://auth.phatt.vip/application/o/stoop/',
  authorization_endpoint: 'https://auth.phatt.vip/application/o/authorize/',
  token_endpoint: 'https://auth.phatt.vip/application/o/token/',
  userinfo_endpoint: 'https://auth.phatt.vip/application/o/userinfo/',
  jwks_uri: 'https://auth.phatt.vip/application/o/stoop/jwks/',
};

const config = {
  issuer: discovery.issuer,
  clientId: 'client-id',
  clientSecret: 'client-secret',
  redirectUri: 'https://stoop.phatt.vip/auth/callback',
  scope: 'openid profile email',
};

function base64url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function signIdToken(claims: IdTokenClaims, privateKey: ReturnType<typeof generateKeyPairSync>['privateKey']): string {
  const header = base64url(Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-key', typ: 'JWT' })));
  const payload = base64url(Buffer.from(JSON.stringify(claims)));
  const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(privateKey);
  return `${header}.${payload}.${base64url(signature)}`;
}

test('PKCE: the challenge is the SHA-256 of the verifier, base64url', () => {
  const pkce = createPkce();
  assert.ok(pkce.verifier.length >= 43);
  const expected = base64url(createHash('sha256').update(pkce.verifier).digest());
  assert.equal(pkce.challenge, expected);
  assert.notEqual(createPkce().verifier, pkce.verifier);
});

test('the authorize URL is code + PKCE + state + nonce, nothing implicit', () => {
  const url = new URL(
    buildAuthorizeUrl(discovery, config, { state: 'st', nonce: 'no', codeChallenge: 'ch' }),
  );
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('client_id'), 'client-id');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://stoop.phatt.vip/auth/callback');
  assert.equal(url.searchParams.get('code_challenge'), 'ch');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('state'), 'st');
  assert.equal(url.searchParams.get('nonce'), 'no');
  assert.equal(url.searchParams.get('response_type'), 'code');
});

test('id_token verification: a valid RS256 token passes', () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256' } as Jwk;
  const claims: IdTokenClaims = {
    iss: discovery.issuer,
    sub: 'user-uuid-1',
    aud: 'client-id',
    exp: Math.floor(Date.now() / 1000) + 300,
    iat: Math.floor(Date.now() / 1000),
    nonce: 'no',
    name: 'Emily',
  };
  const token = signIdToken(claims, privateKey);
  const verified = verifyIdToken(token, {
    jwks: [jwk],
    issuer: discovery.issuer,
    clientId: 'client-id',
    nonce: 'no',
  });
  assert.equal(verified.sub, 'user-uuid-1');
  assert.equal(verified.name, 'Emily');
});

test('id_token verification: wrong audience, wrong issuer, expired, bad nonce all fail', () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256' } as Jwk;
  const now = Math.floor(Date.now() / 1000);
  const base: IdTokenClaims = {
    iss: discovery.issuer,
    sub: 'user-uuid-1',
    aud: 'client-id',
    exp: now + 300,
    iat: now,
    nonce: 'no',
  };
  const options = { jwks: [jwk], issuer: discovery.issuer, clientId: 'client-id', nonce: 'no' };

  assert.throws(
    () => verifyIdToken(signIdToken(base, privateKey), { ...options, clientId: 'other-client' }),
    /audience mismatch/,
  );
  assert.throws(
    () => verifyIdToken(signIdToken(base, privateKey), { ...options, issuer: 'https://elsewhere/' }),
    /issuer mismatch/,
  );
  assert.throws(
    () => verifyIdToken(signIdToken({ ...base, exp: now - 10 }, privateKey), options),
    /expired/,
  );
  assert.throws(
    () => verifyIdToken(signIdToken(base, privateKey), { ...options, nonce: 'different' }),
    /nonce mismatch/,
  );

  // A token signed by someone else's key is not a login.
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const foreign = signIdToken(base, other.privateKey);
  assert.throws(() => verifyIdToken(foreign, options), /signature is invalid/);
});

test('display name falls back down the claim list', () => {
  assert.equal(displayNameFromClaims({ iss: 'i', sub: 's' }, { name: 'Emily Shade' }), 'Emily Shade');
  assert.equal(displayNameFromClaims({ iss: 'i', sub: 's', email: 'emily@example.com' }), 'emily@example.com');
  assert.equal(displayNameFromClaims({ iss: 'i', sub: 's' }), 'PHATT ID');
});

test('random tokens are not guessable', () => {
  const values = new Set(Array.from({ length: 50 }, () => randomToken()));
  assert.equal(values.size, 50);
});
