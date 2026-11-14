/**
 * Stoop — migrations.
 *
 * Every file in db/ is applied once, in name order, inside a transaction, and
 * recorded in schema_migrations. Adding a file is the whole procedure.
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const dbDir = join(here, '..', 'db');

export async function migrate(pool: Pool, log: (message: string) => void = console.log): Promise<string[]> {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);

  // Base schema first (files with no numeric prefix), then numbered migrations
  // in numeric order. "schema.sql" then "002_sessions.sql".
  const files = (await readdir(dbDir))
    .filter((file) => file.endsWith('.sql'))
    .sort((a, b) => {
      const rank = (name: string) => {
        const match = /^(\d+)/.exec(name);
        // No numeric prefix = base schema = first.
        return match ? Number(match[1]) : 0;
      };
      const rankDelta = rank(a) - rank(b);
      if (rankDelta !== 0) return rankDelta;
      return a.localeCompare(b);
    });
  const applied: string[] = [];
  for (const file of files) {
    const existing = await pool.query(`SELECT 1 FROM schema_migrations WHERE name = $1`, [file]);
    if ((existing.rowCount ?? 0) > 0) {
      log(`skip ${file} (already applied)`);
      continue;
    }
    const sql = await readFile(join(dbDir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(`INSERT INTO schema_migrations (name) VALUES ($1)`, [file]);
      await client.query('COMMIT');
      log(`applied ${file}`);
      applied.push(file);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  return applied;
}

if (import.meta.filename === process.argv[1]) {
  const url = process.env.STOOP_DATABASE_URL;
  if (!url) {
    console.error('missing STOOP_DATABASE_URL');
    process.exit(1);
  }
  const pool = new Pool({ connectionString: url });
  migrate(pool)
    .then(() => pool.end())
    .catch(async (error) => {
      console.error(error);
      await pool.end();
      process.exit(1);
    });
}
