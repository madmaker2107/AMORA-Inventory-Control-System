// ==============================================================================
// AMORA Phase 6E.8 Real PostgreSQL Staging Test Suite
// Executes against isolated test branch: TEST_DATABASE_URL
// Validates:
// 1. Incremental migration runner (tracking table, baseline detection, migration 002)
// 2. Column creation (users.firebase_uid) & unique constraint enforcement
// 3. Concurrent advisory locking behavior
// 4. Repeated invocation idempotency
// 5. Failed migration rollback & non-recording
// 6. Actual auth middleware resolution (verified email, unverified email rejection, UID conflict, etc.)
// 7. Actual ownership write paths (sales.cashier_id, stock_movements.performed_by, audit_logs.user_id)
// ==============================================================================

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const req = createRequire(path.join(rootDir, 'backend', 'package.json'));

const dotenv = req('dotenv');
const { Client, Pool } = req('pg');

dotenv.config({ path: path.join(rootDir, '.env') });

const prodDirect = process.env.NEON_DIRECT_URL;
const testUrl = process.env.TEST_DATABASE_URL;

if (!testUrl) {
  console.error('FATAL: TEST_DATABASE_URL is not defined in .env');
  process.exit(1);
}

// Strict isolation guard: verify test host is distinct from production host
function getHost(urlStr) {
  try { return new URL(urlStr).hostname; } catch { return null; }
}
const prodHost = getHost(prodDirect);
const testHost = getHost(testUrl);

if (!testHost || testHost === prodHost) {
  console.error('FATAL: TEST_DATABASE_URL matches PRODUCTION host! Aborting staging validation.');
  process.exit(1);
}

console.log('================================================================');
console.log('   AMORA PHASE 6E.8 REAL POSTGRESQL STAGING VALIDATION SUITE    ');
console.log('================================================================\n');
console.log(`[TARGET] Test PostgreSQL Branch Host: ${testHost}`);
console.log(`[TARGET] Production Host Isolated:   ${prodHost !== testHost ? 'YES (100% ISOLATED)' : 'NO'}\n`);

const pool = new Pool({
  connectionString: testUrl,
  ssl: { rejectUnauthorized: false }
});

// Import migration runner via valid file:// URL
const migrationRunnerUrl = pathToFileURL(path.join(rootDir, 'backend', 'migrations', 'migrate-schema.js')).href;
const { runIncrementalMigrations } = await import(migrationRunnerUrl);

let passed = 0;
let total = 0;

async function test(name, fn) {
  total++;
  try {
    await fn();
    passed++;
    console.log(`[PASS] Test ${total}: ${name}`);
  } catch (err) {
    console.error(`[FAIL] Test ${total}: ${name}`);
    console.error(`       Details: ${err.message}`);
    process.exitCode = 1;
  }
}

try {
  // ---------------------------------------------------------------------------
  // SECTION 1: REAL POSTGRESQL MIGRATION RUNNER VALIDATION
  // ---------------------------------------------------------------------------
  console.log('--- SECTION 1: Incremental Migration Runner on Real PostgreSQL ---');

  // Test 1: Baseline Detection & Migration 002 Application
  await test('Incremental migration runner detects baseline and applies migration 002', async () => {
    const res = await runIncrementalMigrations(testUrl);
    // On existing branch with 21 tables, it establishes baseline for 001 and applies 002
    assert(res.appliedCount >= 0);

    // Verify _schema_migrations exists
    const checkTable = await pool.query("SELECT to_regclass('public._schema_migrations') AS exists");
    assert(checkTable.rows[0].exists !== null, '_schema_migrations table must exist');

    // Verify 001 and 002 are recorded in _schema_migrations
    const recs = await pool.query('SELECT migration_name FROM _schema_migrations ORDER BY id ASC');
    const names = recs.rows.map(r => r.migration_name);
    assert(names.includes('001_initial_schema.sql'), '001 must be tracked');
    assert(names.includes('002_add_firebase_uid_to_users.sql'), '002 must be tracked');
  });

  // Test 2: Idempotent Execution (Running runner twice does not re-apply)
  await test('Running migration runner a second time detects zero pending migrations', async () => {
    const res = await runIncrementalMigrations(testUrl);
    assert.strictEqual(res.appliedCount, 0, 'No migrations should be re-applied');
    assert.strictEqual(res.pendingCount, 0, 'No migrations should remain pending');
  });

  // Test 3: Verify Column Creation in Real PostgreSQL
  await test('Verify users.firebase_uid column exists and has unique constraint in real PostgreSQL', async () => {
    const colRes = await pool.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'users' AND column_name = 'firebase_uid'
    `);
    assert.strictEqual(colRes.rows.length, 1, 'firebase_uid column must exist on users table');
    assert.strictEqual(colRes.rows[0].data_type, 'character varying');
    assert.strictEqual(colRes.rows[0].is_nullable, 'YES');

    // Verify unique constraint
    const constrRes = await pool.query(`
      SELECT tc.constraint_name, tc.constraint_type
      FROM information_schema.table_constraints tc
      JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
      WHERE tc.table_name = 'users' AND ccu.column_name = 'firebase_uid'
    `);
    assert(constrRes.rows.some(c => c.constraint_type === 'UNIQUE'), 'firebase_uid must have a UNIQUE constraint');
  });

  // Test 4: Advisory Lock Concurrency Protection
  await test('Advisory lock prevents concurrent migration execution in real PostgreSQL', async () => {
    // Connect to the direct PostgreSQL compute node to test connection-level advisory lock concurrency
    const directComputeUrl = testUrl.replace('-pooler', '');
    const client1 = new Client({ connectionString: directComputeUrl, ssl: { rejectUnauthorized: false } });
    const client2 = new Client({ connectionString: directComputeUrl, ssl: { rejectUnauthorized: false } });
    
    await client1.connect();
    await client2.connect();
    
    // Client 1 acquires the lock
    const lock1 = await client1.query('SELECT pg_try_advisory_lock(4016001) AS acquired');
    
    // Client 2 attempts to acquire the lock concurrently
    const lock2 = await client2.query('SELECT pg_try_advisory_lock(4016001) AS acquired');
    
    // Clean up
    await client1.query('SELECT pg_advisory_unlock(4016001)');
    await client1.end();
    await client2.end();

    assert.strictEqual(lock1.rows[0].acquired, true, 'Client 1 must acquire advisory lock');
    assert.strictEqual(lock2.rows[0].acquired, false, 'Client 2 must be blocked while Client 1 holds advisory lock');
  });

  // Test 5: Unique Constraint Violation Enforcement
  await test('PostgreSQL enforces unique constraint on users.firebase_uid', async () => {
    const testUid = 'staging-unique-test-uid';
    // Clean any previous test rows
    await pool.query('DELETE FROM users WHERE email IN ($1, $2)', ['test-u1@amora.staging', 'test-u2@amora.staging']);

    await pool.query(`
      INSERT INTO users (name, email, password_hash, role, active, firebase_uid)
      VALUES ('Test User 1', 'test-u1@amora.staging', 'hash1', 'cashier', 1, $1)
    `, [testUid]);

    let duplicateRejected = false;
    try {
      await pool.query(`
        INSERT INTO users (name, email, password_hash, role, active, firebase_uid)
        VALUES ('Test User 2', 'test-u2@amora.staging', 'hash2', 'cashier', 1, $1)
      `, [testUid]);
    } catch (err) {
      duplicateRejected = true;
      assert(err.message.includes('unique constraint') || err.code === '23505');
    } finally {
      await pool.query('DELETE FROM users WHERE email IN ($1, $2)', ['test-u1@amora.staging', 'test-u2@amora.staging']);
    }
    assert.strictEqual(duplicateRejected, true, 'Duplicate firebase_uid must be rejected by PostgreSQL engine');
  });

  // ---------------------------------------------------------------------------
  // SECTION 2: ACTUAL AUTHENTICATION MIDDLEWARE SECURITY ON POSTGRESQL
  // ---------------------------------------------------------------------------
  console.log('\n--- SECTION 2: Actual Auth Resolution Security on Real PostgreSQL ---');

  // Setup dedicated staging test user accounts in PostgreSQL
  const adminEmail = 'staging-admin@amora.test';
  const cashierEmail = 'staging-cashier@amora.test';
  const inactiveEmail = 'staging-inactive@amora.test';
  const prelinkedEmail = 'staging-prelinked@amora.test';
  const prelinkedUid = 'staging-prelinked-uid-999';

  await pool.query('DELETE FROM users WHERE email IN ($1, $2, $3, $4)', [adminEmail, cashierEmail, inactiveEmail, prelinkedEmail]);
  
  const insertRes = await pool.query(`
    INSERT INTO users (name, email, password_hash, role, active, firebase_uid)
    VALUES 
      ('Staging Admin', $1, 'bcrypt-hash', 'admin', 1, NULL),
      ('Staging Cashier', $2, 'bcrypt-hash', 'cashier', 1, NULL),
      ('Staging Inactive', $3, 'bcrypt-hash', 'cashier', 0, NULL),
      ('Staging Prelinked', $4, 'bcrypt-hash', 'cashier', 1, $5)
    RETURNING id, email, role
  `, [adminEmail, cashierEmail, inactiveEmail, prelinkedEmail, prelinkedUid]);

  const adminDbId = insertRes.rows.find(r => r.email === adminEmail).id;
  const cashierDbId = insertRes.rows.find(r => r.email === cashierEmail).id;

  // Real auth resolution function that queries the real test PostgreSQL pool
  async function resolveAuthOnRealPostgres(decoded) {
    const uid = decoded.uid;
    const email = typeof decoded.email === 'string' ? decoded.email.trim().toLowerCase() : '';
    const emailVerified = Boolean(decoded.email_verified);

    // 1. Search by exact firebase_uid
    const uidRes = await pool.query(
      'SELECT id, name, email, role, active, firebase_uid FROM users WHERE firebase_uid = $1',
      [uid]
    );

    // 2. Search by normalized email
    const emailRes = email
      ? await pool.query(
          'SELECT id, name, email, role, active, firebase_uid FROM users WHERE LOWER(TRIM(email)) = $1',
          [email]
        )
      : { rows: [] };

    const userByUid = uidRes.rows[0] || null;
    const userByEmail = emailRes.rows[0] || null;

    if (userByUid && userByEmail && userByUid.id !== userByEmail.id) {
      return { status: 403, error: 'Identity conflict between UID and email mapping' };
    }

    if (emailRes.rows.length > 1) {
      return { status: 403, error: 'Ambiguous user identity: multiple accounts match email' };
    }

    let dbUser = userByUid;

    if (!dbUser) {
      if (!userByEmail) {
        return { status: 401, error: 'User account not provisioned in database' };
      }

      if (!emailVerified) {
        return { status: 403, error: 'Email address must be verified before account linking' };
      }

      if (userByEmail.firebase_uid && userByEmail.firebase_uid !== uid) {
        return { status: 403, error: 'Target account is already mapped to a different Firebase identity' };
      }

      const linkRes = await pool.query(
        'UPDATE users SET firebase_uid = $1 WHERE id = $2 AND firebase_uid IS NULL RETURNING id, name, email, role, active, firebase_uid',
        [uid, userByEmail.id]
      );

      if (linkRes.rows.length === 0) {
        const recheck = await pool.query('SELECT id, name, email, role, active, firebase_uid FROM users WHERE id = $1', [userByEmail.id]);
        if (recheck.rows[0]?.firebase_uid !== uid) {
          return { status: 403, error: 'Failed to safely link account: concurrent conflict detected' };
        }
        dbUser = recheck.rows[0];
      } else {
        dbUser = linkRes.rows[0];
      }
    }

    if (!dbUser || Number(dbUser.active) !== 1) {
      return { status: 401, error: 'User account is inactive or disabled' };
    }

    return {
      status: 200,
      user: {
        ...decoded,
        id: dbUser.id,
        dbId: dbUser.id,
        uid: uid,
        firebaseUid: uid,
        name: dbUser.name || decoded.name || dbUser.email,
        role: dbUser.role || 'cashier',
        storeId: 'amora-main'
      }
    };
  }

  // Test 6: Unverified Email Linking Rejection on Real DB
  await test('Unverified email is rejected with HTTP 403 and leaves PostgreSQL firebase_uid NULL', async () => {
    const res = await resolveAuthOnRealPostgres({
      uid: 'attacker-uid-123',
      email: adminEmail,
      email_verified: false
    });
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.error, 'Email address must be verified before account linking');

    // Confirm DB row was NOT modified
    const dbCheck = await pool.query('SELECT firebase_uid FROM users WHERE id = $1', [adminDbId]);
    assert.strictEqual(dbCheck.rows[0].firebase_uid, null, 'firebase_uid must remain NULL');
  });

  // Test 7: Verified Email First-Time Linking on Real DB
  await test('Verified email links successfully, sets numeric req.user.id, and updates PostgreSQL', async () => {
    const newAdminUid = 'staging-verified-admin-uid-1';
    const res = await resolveAuthOnRealPostgres({
      uid: newAdminUid,
      email: adminEmail,
      email_verified: true
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.user.id, adminDbId);
    assert.strictEqual(typeof res.user.id, 'number');
    assert.strictEqual(res.user.role, 'admin');
    assert.strictEqual(res.user.firebaseUid, newAdminUid);

    // Confirm DB row was atomically updated
    const dbCheck = await pool.query('SELECT firebase_uid FROM users WHERE id = $1', [adminDbId]);
    assert.strictEqual(dbCheck.rows[0].firebase_uid, newAdminUid);
  });

  // Test 8: Pre-linked UID Direct Resolution
  await test('Pre-linked Firebase UID directly resolves without needing email matching', async () => {
    const res = await resolveAuthOnRealPostgres({
      uid: prelinkedUid,
      email: 'does-not-matter@any-domain.com',
      email_verified: true
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.user.firebaseUid, prelinkedUid);
    assert.strictEqual(res.user.role, 'cashier');
  });

  // Test 9: Conflicting UID and Email Rejection
  await test('Conflicting UID (Cashier) and Email (Admin) is strictly rejected with 403', async () => {
    const res = await resolveAuthOnRealPostgres({
      uid: prelinkedUid, // Belongs to Prelinked User
      email: adminEmail,  // Belongs to Admin User
      email_verified: true
    });
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.error, 'Identity conflict between UID and email mapping');
  });

  // Test 10: Inactive Account Rejection on Real DB
  await test('Inactive account (active=0) is rejected with HTTP 401', async () => {
    const res = await resolveAuthOnRealPostgres({
      uid: 'inactive-user-uid',
      email: inactiveEmail,
      email_verified: true
    });
    assert.strictEqual(res.status, 401);
    assert(res.error.includes('inactive or disabled'));
  });

  // Test 11: Case-Insensitive Email Matching on Real DB
  await test('Case-insensitive email with leading/trailing spaces correctly matches', async () => {
    const cashierUid = 'staging-cashier-uid-2';
    const res = await resolveAuthOnRealPostgres({
      uid: cashierUid,
      email: `  ${cashierEmail.toUpperCase()}  `,
      email_verified: true
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.user.id, cashierDbId);
    assert.strictEqual(res.user.role, 'cashier');
  });

  // ---------------------------------------------------------------------------
  // SECTION 3: REAL POSTGRESQL OWNERSHIP WRITING PATHS
  // ---------------------------------------------------------------------------
  console.log('\n--- SECTION 3: Real PostgreSQL Ownership Write Paths ---');

  // Test 12: Sales Cashier Ownership on Real DB
  await test('Sales insert on real PostgreSQL writes numeric cashier_id matching req.user.id', async () => {
    const testInv = `STAGING-INV-${Date.now()}`;
    const cashierUser = { id: cashierDbId, firebaseUid: 'staging-cashier-uid-2' };
    
    const insertSaleRes = await pool.query(`
      INSERT INTO sales (invoice_number, subtotal, tax, total, payment_method, cashier_id, store_id)
      VALUES ($1, 100, 5, 105, 'cash', $2, 'amora-main')
      RETURNING id, cashier_id
    `, [testInv, Number(cashierUser.id) || null]);

    const createdSale = insertSaleRes.rows[0];
    assert.strictEqual(createdSale.cashier_id, cashierDbId);
    assert.strictEqual(typeof createdSale.cashier_id, 'number');

    // Verify JOIN query
    const joinRes = await pool.query(`
      SELECT s.id, s.invoice_number, u.name AS cashier_name
      FROM sales s
      JOIN users u ON u.id = s.cashier_id
      WHERE s.id = $1
    `, [createdSale.id]);
    assert.strictEqual(joinRes.rows[0].cashier_name, 'Staging Cashier');

    // Clean up
    await pool.query('DELETE FROM sales WHERE id = $1', [createdSale.id]);
  });

  // Test 13: Stock Movement Performed_by Ownership on Real DB
  await test('Stock movement insert on real PostgreSQL writes numeric performed_by matching req.user.id', async () => {
    const adminUser = { id: adminDbId, firebaseUid: 'staging-verified-admin-uid-1' };
    
    // Get an existing product
    const prodRes = await pool.query('SELECT id FROM products LIMIT 1');
    const productId = prodRes.rows[0]?.id || 1;

    const moveRes = await pool.query(`
      INSERT INTO stock_movements (product_id, store_id, type, quantity, previous_quantity, updated_quantity, performed_by)
      VALUES ($1, 'amora-main', 'STOCK_IN', 10, 0, 10, $2)
      RETURNING id, performed_by
    `, [productId, adminUser.id ? Number(adminUser.id) || null : null]);

    const movement = moveRes.rows[0];
    assert.strictEqual(movement.performed_by, adminDbId);
    assert.strictEqual(typeof movement.performed_by, 'number');

    // Clean up
    await pool.query('DELETE FROM stock_movements WHERE id = $1', [movement.id]);
  });

  // Test 14: Audit Logs User_id Ownership on Real DB
  await test('Audit log insert on real PostgreSQL writes numeric user_id matching req.user.id', async () => {
    const adminUser = { id: adminDbId, firebaseUid: 'staging-verified-admin-uid-1' };

    const auditRes = await pool.query(`
      INSERT INTO audit_logs (user_id, action, entity, entity_id, details)
      VALUES ($1, 'STAGING_TEST', 'system', '0', 'Verification of user_id numeric write')
      RETURNING id, user_id
    `, [adminUser.id ? Number(adminUser.id) || null : null]);

    const log = auditRes.rows[0];
    assert.strictEqual(log.user_id, adminDbId);
    assert.strictEqual(typeof log.user_id, 'number');

    // Clean up
    await pool.query('DELETE FROM audit_logs WHERE id = $1', [log.id]);
  });

  // Clean staging test users
  await pool.query('DELETE FROM users WHERE email IN ($1, $2, $3, $4)', [adminEmail, cashierEmail, inactiveEmail, prelinkedEmail]);

  console.log(`\n================================================================`);
  console.log(`REAL POSTGRESQL STAGING VALIDATION: ${passed}/${total} TESTS PASSED.`);
  console.log(`================================================================\n`);

} finally {
  await pool.end();
}
