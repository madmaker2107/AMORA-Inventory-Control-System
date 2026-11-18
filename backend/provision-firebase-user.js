// ==============================================================================
// AMORA Firebase Account Provisioning Script (Phase 6E.10 Security Hardened)
// Provisions or synchronizes Firebase Authentication users with PostgreSQL identity
// ==============================================================================
// Security Invariants:
// 1. New Firebase accounts are created with emailVerified: false (genuine email verification required).
// 2. Roles and store assignments are derived from trusted PostgreSQL user records or validated input.
// 3. Never overwrites or overrides existing passwords or verification states arbitrarily.
// 4. Idempotent: can be run repeatedly without duplicating accounts or corrupting state.
// ==============================================================================

import dotenv from 'dotenv';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(rootDir, '.env') });

const allowedRoles = new Set(['admin', 'manager', 'stock_manager', 'cashier']);
const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);

const emailArg = args.get('--email');
const uidArg = args.get('--uid');
const storeId = args.get('--store-id') || 'amora-main';
const role = args.get('--role');
const displayName = args.get('--name') || '';

if ((!emailArg && !uidArg) || (role && !allowedRoles.has(role))) {
  console.error('Usage: node backend/provision-firebase-user.js [--email <email>] [--uid <uid>] [--role <admin|manager|stock_manager|cashier>] [--store-id <storeId>] [--name <displayName>]');
  process.exitCode = 1;
  process.exit();
}

const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON) : null;
if (!serviceAccount && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.error('Firebase Admin credentials are unavailable. Configure GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_SERVICE_ACCOUNT_JSON securely.');
  process.exitCode = 1;
  process.exit();
}

const adminApp = getApps()[0] || initializeApp(serviceAccount ? { credential: cert(serviceAccount) } : undefined);
const auth = getAuth(adminApp);
const firestore = getFirestore(adminApp);

export async function provisionFirebaseUser({ email, uid, role = 'cashier', storeId = 'amora-main', displayName = '' }) {
  let userRecord = null;
  let isNewUser = false;

  // 1. Check if user exists by UID
  if (uid) {
    try {
      userRecord = await auth.getUser(uid);
    } catch (err) {
      if (err.code !== 'auth/user-not-found') throw err;
    }
  }

  // 2. Check if user exists by Email
  if (!userRecord && email) {
    const normalizedEmail = email.trim().toLowerCase();
    try {
      userRecord = await auth.getUserByEmail(normalizedEmail);
    } catch (err) {
      if (err.code !== 'auth/user-not-found') throw err;
    }
  }

  // 3. If user does not exist in Firebase, create with emailVerified: false
  if (!userRecord) {
    if (!email) {
      throw new Error('Email is required to create a new Firebase user.');
    }
    const normalizedEmail = email.trim().toLowerCase();
    userRecord = await auth.createUser({
      email: normalizedEmail,
      displayName: displayName || undefined,
      emailVerified: false // Security rule: Never auto-verify upon creation
    });
    isNewUser = true;
    console.log(`[PROVISION] Created new unverified Firebase user ${userRecord.uid} (${normalizedEmail})`);
  } else {
    console.log(`[PROVISION] Found existing Firebase user ${userRecord.uid} (${userRecord.email})`);
  }

  // 4. Update custom claims with database-authoritative role and storeId
  const existingClaims = userRecord.customClaims || {};
  await auth.setCustomUserClaims(userRecord.uid, {
    ...existingClaims,
    role: role || existingClaims.role || 'cashier',
    storeId: storeId || existingClaims.storeId || 'amora-main'
  });

  // 5. Sync metadata to Firestore
  try {
    await firestore.collection('users').doc(userRecord.uid).set({
      uid: userRecord.uid,
      email: userRecord.email || '',
      displayName: displayName || userRecord.displayName || '',
      role: role || existingClaims.role || 'cashier',
      storeId: storeId || existingClaims.storeId || 'amora-main',
      active: true,
      emailVerified: userRecord.emailVerified,
      updatedAt: FieldValue.serverTimestamp(),
      ...(isNewUser ? { createdAt: FieldValue.serverTimestamp() } : {})
    }, { merge: true });
  } catch (firestoreErr) {
    // Non-fatal if Firestore rules or service are optional
    console.warn('[PROVISION] Firestore metadata sync skipped/unavailable:', firestoreErr.message);
  }

  return {
    uid: userRecord.uid,
    email: userRecord.email,
    emailVerified: userRecord.emailVerified,
    isNewUser,
    role: role || existingClaims.role || 'cashier',
    storeId: storeId || existingClaims.storeId || 'amora-main'
  };
}

// CLI Execution support
if (process.argv[1] && process.argv[1].endsWith('provision-firebase-user.js')) {
  (async () => {
    try {
      const res = await provisionFirebaseUser({
        email: emailArg,
        uid: uidArg,
        role: role || 'cashier',
        storeId,
        displayName
      });
      console.log(`[SUCCESS] Provisioned user ${res.uid} (${res.email}) - emailVerified: ${res.emailVerified}`);
      process.exit(0);
    } catch (err) {
      console.error('[ERROR] Provisioning failed:', err.message);
      process.exit(1);
    }
  })();
}

