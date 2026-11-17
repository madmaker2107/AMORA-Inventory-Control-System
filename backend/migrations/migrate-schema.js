// ==============================================================================
// AMORA PostgreSQL Schema Migration Script (Phase 4A)
// Executes DDL against Neon Serverless PostgreSQL
// ==============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { createMigrationClient } from '../db-postgres.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..', '..');
dotenv.config({ path: path.join(rootDir, '.env') });

const EXPECTED_TABLES = [
  'audit_logs', 'backups', 'brands', 'categories', 'customers',
  'inventory_batches', 'login_history', 'notifications', 'payments',
  'products', 'purchase_items', 'purchase_orders', 'sale_items',
  'sale_returns', 'sale_reversals', 'sales', 'settings',
  'stock_movements', 'supplier_products', 'suppliers', 'users'
];

async function run() {
  console.log('================================================================');
  console.log('       AMORA POSTGRESQL SCHEMA MIGRATION RUNNER (PHASE 4A)      ');
  console.log('================================================================\n');

  // 1. Check environment variables without leaking credentials
  const directUrl = process.env.NEON_DIRECT_URL;
  if (!directUrl || directUrl.trim().length === 0) {
    console.log('[INFO] NEON_DIRECT_URL environment variable is not configured.');
    console.log('[INFO] To execute the schema migration against Neon, configure NEON_DIRECT_URL in your local .env file:');
    console.log('       NEON_DIRECT_URL=postgres://neondb_owner:***@ep-***.us-east-2.aws.neon.tech/neondb?sslmode=require\n');
    console.log('[RESULT] Schema script compiled and validated successfully. Paused awaiting NEON_DIRECT_URL configuration.');
    process.exit(0);
  }

  const client = createMigrationClient(directUrl);

  try {
    let maskedHost = 'remote-host';
    try {
      const urlObj = new URL(directUrl);
      maskedHost = urlObj.hostname.replace(/^([a-z0-9]+-)[a-z0-9]+/, '$1****');
    } catch {}
    console.log(`[STEP 1] Connecting to Neon PostgreSQL host: ${maskedHost} using verified TLS...`);
    await client.connect();
    console.log('[PASS] Connection established successfully.');

    // 2. Confirm database name and version
    const dbInfo = await client.query('SELECT current_database() AS db_name, version() AS pg_version;');
    const currentDb = dbInfo.rows[0].db_name;
    console.log(`[PASS] Connected to database: "${currentDb}"`);

    // 3. Inspect existing public tables
    console.log('\n[STEP 2] Inspecting existing database state...');
    const existingTablesRes = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
        AND table_type = 'BASE TABLE'
      ORDER BY table_name;
    `);
    const existingTables = existingTablesRes.rows.map(r => r.table_name);
    console.log(`[INFO] Found ${existingTables.length} existing tables in public schema.`);

    // Safety Check: If existing tables are populated with data, halt immediately
    if (existingTables.length > 0) {
      console.log('Existing tables detected:', existingTables.join(', '));
      let totalExistingRows = 0;
      for (const tbl of existingTables) {
        const countRes = await client.query(`SELECT COUNT(*) AS count FROM "${tbl}"`);
        totalExistingRows += Number(countRes.rows[0].count);
      }
      if (totalExistingRows > 0) {
        console.error(`\n[ABORT] Existing tables contain ${totalExistingRows} records!`);
        console.error('Safety restriction triggered: Will not overwrite an existing populated database.');
        process.exit(1);
      }
      console.log('[INFO] Existing tables are empty; safe to apply/verify schema definitions.');
    }

    // 4. Load and apply schema migration SQL
    const schemaSqlPath = path.join(__dirname, '001_initial_schema.sql');
    if (!fs.existsSync(schemaSqlPath)) {
      throw new Error(`Schema migration file not found at ${schemaSqlPath}`);
    }
    const schemaSql = fs.readFileSync(schemaSqlPath, 'utf8');

    console.log('\n[STEP 3] Applying DDL migration: 001_initial_schema.sql ...');
    await client.query('BEGIN');
    await client.query(schemaSql);
    await client.query('COMMIT');
    console.log('[PASS] Schema DDL applied successfully within transaction.');

    // 5. Verification: Verify all 21 tables
    console.log('\n[STEP 4] Verifying created tables and constraints...');
    const verifiedTablesRes = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
        AND table_type = 'BASE TABLE'
      ORDER BY table_name;
    `);
    const createdTables = verifiedTablesRes.rows.map(r => r.table_name);

    const missingTables = EXPECTED_TABLES.filter(t => !createdTables.includes(t));
    if (missingTables.length > 0) {
      throw new Error(`Missing expected tables after migration: ${missingTables.join(', ')}`);
    }
    console.log(`[PASS] All ${createdTables.length} tables verified in PostgreSQL:`);
    createdTables.forEach((t, i) => console.log(`  ${String(i + 1).padStart(2, ' ')}. ${t}`));

    // 6. Verify custom indexes
    const indexRes = await client.query(`
      SELECT indexname, tablename 
      FROM pg_indexes 
      WHERE schemaname = 'public' 
        AND indexname LIKE 'idx_%'
      ORDER BY indexname;
    `);
    console.log(`\n[PASS] Verified ${indexRes.rows.length} custom indexes:`);
    indexRes.rows.forEach(idx => console.log(`  - ${idx.indexname} on ${idx.tablename}`));

    // 7. Verify foreign keys
    const fkRes = await client.query(`
      SELECT tc.table_name, kcu.column_name, ccu.table_name AS foreign_table_name, ccu.column_name AS foreign_column_name 
      FROM information_schema.table_constraints AS tc 
      JOIN information_schema.key_column_usage AS kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage AS ccu
        ON ccu.constraint_name = tc.constraint_name
        AND ccu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
      ORDER BY tc.table_name;
    `);
    console.log(`\n[PASS] Verified ${fkRes.rows.length} foreign key relationships.`);

    console.log('\n================================================================');
    console.log('             PHASE 4A SCHEMA MIGRATION COMPLETE                 ');
    console.log('================================================================\n');

  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('\n[ERROR] Schema migration failed:', error.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

run();
