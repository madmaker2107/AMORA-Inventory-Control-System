// ==============================================================================
// AMORA PostgreSQL Database Client & Connection Manager
// Target: Neon Serverless PostgreSQL
// ==============================================================================

import pg from 'pg';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { Pool, Client, types } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

// Register Type Parsers to match SQLite JavaScript types:
// OID 1700 = NUMERIC / DECIMAL -> Float
types.setTypeParser(1700, (val) => (val === null ? null : parseFloat(val)));
// OID 20 = INT8 / BIGINT (e.g. COUNT(*)) -> Integer
types.setTypeParser(20, (val) => (val === null ? null : parseInt(val, 10)));

/**
 * Creates a standard TLS configuration enforcing strict certificate validation.
 * Neon certificates chain to trusted public root CAs embedded in Node.js.
 */
function createSslConfig() {
  return {
    rejectUnauthorized: true
  };
}

/**
 * Returns a connection pool configured for runtime application queries.
 * Connects via Neon's connection pooler (-pooler endpoint) or direct endpoint.
 */
export function createRuntimePool(connectionString = process.env.DATABASE_URL || process.env.NEON_DIRECT_URL) {
  if (!connectionString) {
    throw new Error('DATABASE_URL or NEON_DIRECT_URL environment variable is not defined.');
  }

  const pool = new Pool({
    connectionString,
    ssl: createSslConfig(),
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });

  pool.on('error', (err) => {
    console.error('Unexpected error on idle PostgreSQL client:', err.message);
  });

  return pool;
}

/**
 * Returns a single dedicated Client for schema DDL and migrations.
 * Uses NEON_DIRECT_URL (non-pooled direct endpoint).
 */
export function createMigrationClient(connectionString = process.env.NEON_DIRECT_URL || process.env.DATABASE_URL) {
  if (!connectionString) {
    throw new Error('NEON_DIRECT_URL (or DATABASE_URL) environment variable is not defined.');
  }

  return new Client({
    connectionString,
    ssl: createSslConfig(),
    connectionTimeoutMillis: 15000,
  });
}

/**
 * Executes a callback within a managed database transaction.
 * Guarantees that every query inside the callback runs on the same checked-out client.
 * Supports both withTransaction(pool, callback) and withTransaction(callback).
 */
export async function withTransaction(poolOrCallback, maybeCallback) {
  const pool = typeof poolOrCallback === 'function' ? getDb() : poolOrCallback;
  const callback = typeof poolOrCallback === 'function' ? poolOrCallback : maybeCallback;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

// Default export: Lazily initialized runtime pool
let defaultPool = null;
export function getDb() {
  if (!defaultPool) {
    defaultPool = createRuntimePool();
  }
  return defaultPool;
}

/**
 * Convenience helper to execute a query on the pool.
 */
export async function query(text, params = []) {
  const pool = getDb();
  return pool.query(text, params);
}

/**
 * Convenience helper returning the first row or null.
 */
export async function queryOne(text, params = []) {
  const res = await query(text, params);
  return res.rows[0] || null;
}

/**
 * Convenience helper returning array of rows.
 */
export async function queryMany(text, params = []) {
  const res = await query(text, params);
  return res.rows;
}

export default {
  createRuntimePool,
  createMigrationClient,
  withTransaction,
  getDb,
  query,
  queryOne,
  queryMany
};
