-- ==============================================================================
-- AMORA Migration 002: Add Firebase UID mapping column to users table
-- ==============================================================================
-- Adds a nullable, unique firebase_uid column to enable deterministic mapping
-- between Firebase Authentication identities and PostgreSQL integer primary keys.
-- Preserves existing numeric IDs, foreign keys, password hashes, and user roles.

ALTER TABLE users 
ADD COLUMN IF NOT EXISTS firebase_uid VARCHAR(128) UNIQUE;

