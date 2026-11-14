/**
 * Stoop — entrypoint.
 *
 * Wires the Postgres ledger, the PHATT ID login and the app's own short
 * session into the HTTP shell, then listens. Everything else is config.
 */

import { Pool } from 'pg';
import { AuthService } from './auth.ts';
import { loadConfig } from './config.ts';
import type { Ledger } from './ledger.ts';
import { migrate } from './migrate.ts';
import { createApp } from './server.ts';
import { SessionStore } from './session.ts';
import { PgLedger } from './store.ts';

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

const { server } = createApp({
  // The Postgres store implements the same contract as the in-memory ledger.
  ledger: ledger as unknown as Ledger,
  verifySession: (token) => sessions.verify(token),
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
