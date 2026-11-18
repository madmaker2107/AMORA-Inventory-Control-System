// ==============================================================================
// AMORA Incremental Schema Migration Runner
// Safely tracks and applies ordered SQL migrations against PostgreSQL
// ==============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { createMigrationClient } from '../db-postgres.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..', '..');
dotenv.config({ path: path.join(rootDir, '.env') });

const MIGRATIONS_DIR = __dirname;
const ADVISORY_LOCK_ID = 4016001; // Unique 64-bit application lock key for AMORA migrations

async function ensureMigrationTracking(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS _schema_migrations (
      id SERIAL PRIMARY KEY,
      migration_name VARCHAR(255) UNIQUE NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      checksum VARCHAR(64)
    );
  `);
}

export async function runIncrementalMigrations(targetDatabaseUrl = null, options = {}) {
  const connectionUrl = targetDatabaseUrl || process.env.NEON_DIRECT_URL || process.env.DATABASE_URL;
  if (!connectionUrl) {
    throw new Error('No database connection URL provided or found in environment variables.');
  }

  const client = createMigrationClient(connectionUrl);
  await client.connect();

  try {
    // 1. Acquire transactional advisory lock to prevent concurrent execution
    console.log('[MIGRATION] Acquiring global migration advisory lock...');
    const lockRes = await client.query('SELECT pg_try_advisory_lock($1) AS acquired', [ADVISORY_LOCK_ID]);
    if (!lockRes.rows[0].acquired) {
      throw new Error('Another migration process is currently running on this database.');
    }

    // 2. Ensure schema tracking table exists
    await ensureMigrationTracking(client);

    // 3. Inspect existing tables to establish baseline if unrecorded
    const existingTablesRes = await client.query(`
      SELECT table_name FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name != '_schema_migrations';
    `);
    const existingTableCount = existingTablesRes.rows.length;

    // 4. Check already applied migrations
    const appliedRes = await client.query('SELECT migration_name FROM _schema_migrations ORDER BY id ASC');
    const appliedSet = new Set(appliedRes.rows.map(r => r.migration_name));

    // Baseline detection: If 001_initial_schema.sql was applied previously before tracking table existed
    if (existingTableCount >= 20 && !appliedSet.has('001_initial_schema.sql')) {
      console.log('[MIGRATION] Baseline detected: 001_initial_schema.sql was already applied. Marking as baseline.');
      await client.query(
        'INSERT INTO _schema_migrations (migration_name, checksum) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        ['001_initial_schema.sql', 'baseline-pre-existing']
      );
      appliedSet.add('001_initial_schema.sql');
    }

    // 5. Discover all numbered SQL files in migrations directory
    const files = fs.readdirSync(MIGRATIONS_DIR)
      .filter(f => /^\d+_.+\.sql$/.test(f))
      .sort((a, b) => a.localeCompare(b));

    const pending = files.filter(f => !appliedSet.has(f));
    console.log(`[MIGRATION] Found ${files.length} total migrations. ${appliedSet.size} applied, ${pending.length} pending.`);

    if (pending.length === 0) {
      console.log('[MIGRATION] Database is fully up-to-date.');
      return { appliedCount: 0, pendingCount: 0 };
    }

    // 6. Apply pending migrations sequentially within individual transactions
    let count = 0;
    for (const migrationFile of pending) {
      const fullPath = path.join(MIGRATIONS_DIR, migrationFile);
      const sql = fs.readFileSync(fullPath, 'utf8');

      console.log(`[MIGRATION] Applying: ${migrationFile} ...`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO _schema_migrations (migration_name, checksum) VALUES ($1, $2)',
          [migrationFile, `applied-${Date.now()}`]
        );
        await client.query('COMMIT');
        console.log(`[MIGRATION] Successfully applied: ${migrationFile}`);
        count++;
      } catch (migrationError) {
        await client.query('ROLLBACK');
        console.error(`[MIGRATION] Failed applying ${migrationFile}:`, migrationError.message);
        throw new Error(`Migration ${migrationFile} failed: ${migrationError.message}`);
      }
    }

    return { appliedCount: count, pendingCount: pending.length - count };
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_ID]);
    } catch {}
    await client.end();
  }
}

// Allow CLI invocation
if (process.argv[1] && process.argv[1].endsWith('migrate-schema.js')) {
  (async () => {
    try {
      console.log('================================================================');
      console.log('       AMORA INCREMENTAL SCHEMA MIGRATION RUNNER                ');
      console.log('================================================================\n');
      const result = await runIncrementalMigrations();
      console.log(`\n[RESULT] Migration complete. Applied: ${result.appliedCount}`);
      process.exit(0);
    } catch (err) {
      console.error('\n[FATAL] Migration aborted:', err.message);
      process.exit(1);
    }
  })();
}
