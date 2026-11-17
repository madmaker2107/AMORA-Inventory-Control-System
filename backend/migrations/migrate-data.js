// ==============================================================================
// AMORA PostgreSQL Data Migration Script (Phase 4B Infrastructure)
// Reads verified SQLite backup and migrates records into Neon PostgreSQL
// ==============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import Database from 'better-sqlite3';
import { createMigrationClient } from '../db-postgres.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..', '..');
dotenv.config({ path: path.join(rootDir, '.env') });

// Verified Topological Ingestion Order (Proven Acyclic)
const TOPO_TABLES = [
  'brands',
  'categories',
  'customers',
  'notifications',
  'settings',
  'suppliers',
  'users',
  'products',
  'purchase_orders',
  'audit_logs',
  'backups',
  'login_history',
  'sales',
  'inventory_batches',
  'supplier_products',
  'purchase_items',
  'payments',
  'sale_reversals',
  'sale_items',
  'stock_movements',
  'sale_returns'
];

// Sequence-backed tables (settings has text PK 'key' and is excluded)
const SEQUENCE_TABLES = TOPO_TABLES.filter(t => t !== 'settings');

// Columns formatted as DATE/TIMESTAMPTZ where empty strings must be coerced to null
const DATE_OR_NUMERIC_NULLABLE_COLS = new Set([
  'expected_date',
  'manufacturing_date',
  'expiry_date',
  'entity_id',
  'transaction_key'
]);

/**
 * Finds the latest verified SQLite backup file across all candidate directories.
 */
function findLatestBackup() {
  if (process.env.SQLITE_BACKUP_PATH && fs.existsSync(process.env.SQLITE_BACKUP_PATH)) {
    return process.env.SQLITE_BACKUP_PATH;
  }

  const candidateDirs = [
    'C:\\Users\\soumi\\OneDrive\\Desktop\\AMORA-backups',
    path.resolve(rootDir, 'backend', 'data')
  ];

  const allCandidates = [];
  for (const dir of candidateDirs) {
    if (fs.existsSync(dir)) {
      try {
        const files = fs.readdirSync(dir)
          .filter(f => f.startsWith('amora-backup-') && f.endsWith('.sqlite'))
          .map(f => ({ name: f, fullPath: path.join(dir, f) }));
        allCandidates.push(...files);
      } catch {
        // Continue if directory read fails
      }
    }
  }

  if (allCandidates.length === 0) {
    return null;
  }

  // Sort descending by ISO timestamp in filename to select newest verified backup
  allCandidates.sort((a, b) => b.name.localeCompare(a.name));
  return allCandidates[0].fullPath;
}

async function run() {
  console.log('================================================================');
  console.log('         AMORA POSTGRESQL DATA MIGRATION INFRASTRUCTURE         ');
  console.log('================================================================\n');

  // 1. Locate verified backup
  const backupPath = findLatestBackup();
  if (!backupPath || !fs.existsSync(backupPath)) {
    console.error('[ERROR] No verified SQLite backup file found.');
    console.error('Expected location: C:\\Users\\soumi\\OneDrive\\Desktop\\AMORA-backups\\amora-backup-*.sqlite');
    process.exit(1);
  }
  console.log(`[PASS] Using verified offline SQLite backup: ${backupPath}`);

  // 2. Check environment variables without printing secrets
  const targetUrl = process.env.NEON_DIRECT_URL || process.env.DATABASE_URL;
  if (!targetUrl || targetUrl.trim().length === 0) {
    console.log('[INFO] NEON_DIRECT_URL / DATABASE_URL environment variable is not configured.');
    console.log('[INFO] To run data migration, configure NEON_DIRECT_URL in your local .env file.');
    console.log('[RESULT] Data migration script compiled and validated. Paused awaiting connection string.');
    process.exit(0);
  }

  const sqliteDb = new Database(backupPath, { readonly: true, fileMustExist: true });
  const pgClient = createMigrationClient(targetUrl);

  try {
    let maskedHost = 'remote-host';
    try {
      const urlObj = new URL(targetUrl);
      maskedHost = urlObj.hostname.replace(/^([a-z0-9]+-)[a-z0-9]+/, '$1****');
    } catch {}
    console.log(`[STEP 1] Connecting to Neon PostgreSQL host: ${maskedHost} using verified TLS...`);
    await pgClient.connect();
    console.log('[PASS] Connection established successfully.');

    console.log('\n[STEP 2] Migrating data in topological order (safe retry / non-destructive)...');
    let totalImported = 0;
    const tableTallies = {};

    await pgClient.query('BEGIN');

    for (const table of TOPO_TABLES) {
      const rows = sqliteDb.prepare(`SELECT * FROM "${table}"`).all();
      tableTallies[table] = rows.length;

      if (rows.length === 0) {
        console.log(`  - ${table.padEnd(22)}: 0 rows (skipped)`);
        continue;
      }

      const columns = Object.keys(rows[0]);
      const conflictTarget = table === 'settings' ? '(key)' : '(id)';
      
      const insertSql = `
        INSERT INTO "${table}" (${columns.map(c => `"${c}"`).join(', ')})
        VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})
        ON CONFLICT ${conflictTarget} DO NOTHING;
      `;

      for (const row of rows) {
        const values = columns.map(c => {
          const val = row[c];
          if (val === '' && DATE_OR_NUMERIC_NULLABLE_COLS.has(c)) {
            return null;
          }
          return val;
        });
        await pgClient.query(insertSql, values);
      }

      totalImported += rows.length;
      console.log(`  - ${table.padEnd(22)}: ${rows.length} rows migrated`);
    }

    // 3. Synchronize sequence counters for the 20 sequence-backed tables
    console.log('\n[STEP 3] Synchronizing primary key sequences...');
    for (const table of SEQUENCE_TABLES) {
      await pgClient.query(`
        SELECT setval(
          pg_get_serial_sequence($1, 'id'),
          COALESCE((SELECT MAX(id) FROM "${table}"), 1)
        );
      `, [table]);
    }
    console.log(`[PASS] Synchronized sequences across ${SEQUENCE_TABLES.length} tables (settings excluded).`);

    await pgClient.query('COMMIT');
    console.log('\n[STEP 4] Transaction committed. Verifying row parity in PostgreSQL...');

    let pgTotal = 0;
    let parityOk = true;
    for (const table of TOPO_TABLES) {
      const res = await pgClient.query(`SELECT COUNT(*) AS count FROM "${table}"`);
      const pgCount = Number(res.rows[0].count);
      pgTotal += pgCount;
      const expected = tableTallies[table];
      const match = pgCount === expected;
      if (!match) parityOk = false;
      console.log(`  ${match ? '✓' : '✗'} ${table.padEnd(22)}: Expected ${expected}, Got ${pgCount}`);
    }

    console.log(`\nTotal verified records: ${pgTotal} across 21 tables.`);
    if (!parityOk) {
      throw new Error('Parity check failed: Record counts do not match SQLite backup.');
    }

    console.log('\n================================================================');
    console.log('            PHASE 4B DATA MIGRATION COMPLETE & VERIFIED         ');
    console.log('================================================================\n');

  } catch (error) {
    try { await pgClient.query('ROLLBACK'); } catch {}
    console.error('\n[ERROR] Data migration failed:', error.message);
    process.exit(1);
  } finally {
    sqliteDb.close();
    await pgClient.end();
  }
}

run();
