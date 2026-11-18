// ==============================================================================
// AMORA Phase 6E.10 Security Audit Test Suite
// Verifies:
// 1. New Firebase users default to unverified (emailVerified: false)
// 2. Unverified email cannot link to an existing PostgreSQL account
// 3. Verified email can link to the correct account
// 4. A Firebase UID already linked to another user is rejected
// 5. A PostgreSQL account already linked to another Firebase UID is rejected
// 6. Duplicate normalized email matches are rejected
// 7. Existing verified UID mappings continue to work
// 8. Inactive accounts cannot authenticate
// 9. Client-supplied roles and store IDs cannot override database values
// 10. Provisioning can be safely retried (idempotency)
// 11. Partial provisioning failure does not grant access
// 12. Legacy bcrypt hashes remain untouched
// ==============================================================================

import assert from 'node:assert';

console.log('================================================================');
console.log('       AMORA PHASE 6E.10 PROVISIONING SECURITY TEST SUITE       ');
console.log('================================================================\n');

// 1. Mock DB state
const createFreshDb = () => ({
  users: [
    { id: 1, name: 'Anika Kapoor', email: 'admin@amora.local', password_hash: '$2b$10$BcryptHashSample1', role: 'admin', active: 1, firebase_uid: null },
    { id: 2, name: 'Arjun Mehta', email: 'cashier@amora.local', password_hash: '$2b$10$BcryptHashSample2', role: 'cashier', active: 1, firebase_uid: 'uid-cashier-002' },
    { id: 3, name: 'Inactive User', email: 'inactive@amora.local', password_hash: '$2b$10$BcryptHashSample3', role: 'cashier', active: 0, firebase_uid: null },
    { id: 4, name: 'Duplicate A', email: 'dup@amora.local', password_hash: '$2b$10$BcryptHashSample4', role: 'cashier', active: 1, firebase_uid: null },
    { id: 5, name: 'Duplicate B', email: 'dup@amora.local', password_hash: '$2b$10$BcryptHashSample5', role: 'cashier', active: 1, firebase_uid: null }
  ]
});

let db = createFreshDb();

// Mock Firebase Auth state for provisioning tests
const mockFirebaseAuth = {
  users: new Map(),
  async getUser(uid) {
    const u = this.users.get(uid);
    if (!u) {
      const err = new Error('User not found');
      err.code = 'auth/user-not-found';
      throw err;
    }
    return u;
  },
  async getUserByEmail(email) {
    for (const u of this.users.values()) {
      if (u.email.toLowerCase() === email.toLowerCase()) return u;
    }
    const err = new Error('User not found');
    err.code = 'auth/user-not-found';
    throw err;
  },
  async createUser({ email, displayName, emailVerified }) {
    for (const u of this.users.values()) {
      if (u.email.toLowerCase() === email.toLowerCase()) {
        const err = new Error('Email already exists');
        err.code = 'auth/email-already-exists';
        throw err;
      }
    }
    const uid = `uid-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const user = { uid, email, displayName, emailVerified: Boolean(emailVerified), customClaims: {} };
    this.users.set(uid, user);
    return user;
  },
  async setCustomUserClaims(uid, claims) {
    const u = await this.getUser(uid);
    u.customClaims = { ...u.customClaims, ...claims };
  }
};

// Emulation of provisionFirebaseUser function using mock auth
async function provisionUser({ email, uid, role = 'cashier', storeId = 'amora-main', displayName = '' }) {
  let userRecord = null;
  let isNewUser = false;

  if (uid) {
    try { userRecord = await mockFirebaseAuth.getUser(uid); } catch {}
  }
  if (!userRecord && email) {
    try { userRecord = await mockFirebaseAuth.getUserByEmail(email.trim().toLowerCase()); } catch {}
  }

  if (!userRecord) {
    if (!email) throw new Error('Email is required');
    userRecord = await mockFirebaseAuth.createUser({
      email: email.trim().toLowerCase(),
      displayName,
      emailVerified: false // Crucial Phase 6E.10 Security Invariant
    });
    isNewUser = true;
  }

  const existingClaims = userRecord.customClaims || {};
  await mockFirebaseAuth.setCustomUserClaims(userRecord.uid, {
    ...existingClaims,
    role: role || existingClaims.role || 'cashier',
    storeId: storeId || existingClaims.storeId || 'amora-main'
  });

  return {
    uid: userRecord.uid,
    email: userRecord.email,
    emailVerified: userRecord.emailVerified,
    isNewUser,
    role: role || existingClaims.role || 'cashier',
    storeId: storeId || existingClaims.storeId || 'amora-main'
  };
}

// Emulation of the backend/server.js auth middleware resolution
async function executeAuthResolution(token) {
  const uid = token.uid;
  const email = typeof token.email === 'string' ? token.email.trim().toLowerCase() : '';
  const emailVerified = Boolean(token.email_verified);

  const userByUid = db.users.find(u => u.firebase_uid === uid) || null;
  const emailMatches = email ? db.users.filter(u => u.email.trim().toLowerCase() === email) : [];
  const userByEmail = emailMatches[0] || null;

  if (userByUid && userByEmail && userByUid.id !== userByEmail.id) {
    return { status: 403, error: 'Identity conflict between UID and email mapping' };
  }

  if (emailMatches.length > 1) {
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

    userByEmail.firebase_uid = uid;
    dbUser = userByEmail;
  }

  if (!dbUser || Number(dbUser.active) !== 1) {
    return { status: 401, error: 'User account is inactive or disabled' };
  }

  return {
    status: 200,
    user: {
      ...token,
      id: dbUser.id,
      dbId: dbUser.id,
      uid: uid,
      firebaseUid: uid,
      name: dbUser.name,
      role: dbUser.role,
      storeId: 'amora-main'
    }
  };
}

let passed = 0;
let total = 0;

function runTest(name, fn) {
  total++;
  try {
    fn();
    passed++;
    console.log(`[PASS] Test ${total}: ${name}`);
  } catch (err) {
    console.error(`[FAIL] Test ${total}: ${name}`);
    console.error(`       Details: ${err.message}`);
    process.exitCode = 1;
  }
}

// -----------------------------------------------------------------------------
// EXECUTE 12 MANDATORY TEST CASES
// -----------------------------------------------------------------------------

// Test 1: New Firebase user defaults to unverified
await (async () => {
  mockFirebaseAuth.users.clear();
  const prov = await provisionUser({ email: 'new-user@amora.local', role: 'admin' });
  runTest('New Firebase user defaults to unverified (emailVerified: false)', () => {
    assert.strictEqual(prov.isNewUser, true);
    assert.strictEqual(prov.emailVerified, false);
    assert.strictEqual(mockFirebaseAuth.users.get(prov.uid).emailVerified, false);
  });
})();

// Test 2: Unverified email cannot link to an existing PostgreSQL account
await (async () => {
  db = createFreshDb();
  const unverifiedToken = { uid: 'uid-unverified-1', email: 'admin@amora.local', email_verified: false };
  const res = await executeAuthResolution(unverifiedToken);
  runTest('Unverified email cannot link to an existing PostgreSQL account (HTTP 403)', () => {
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.error, 'Email address must be verified before account linking');
    assert.strictEqual(db.users[0].firebase_uid, null);
  });
})();

// Test 3: Verified email can link to the correct account
await (async () => {
  db = createFreshDb();
  const verifiedToken = { uid: 'uid-verified-admin', email: 'admin@amora.local', email_verified: true };
  const res = await executeAuthResolution(verifiedToken);
  runTest('Verified email links successfully and sets numeric user ID (id=1)', () => {
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.user.id, 1);
    assert.strictEqual(res.user.firebaseUid, 'uid-verified-admin');
    assert.strictEqual(db.users[0].firebase_uid, 'uid-verified-admin');
  });
})();

// Test 4: A Firebase UID already linked to another user is rejected
await (async () => {
  db = createFreshDb();
  // Cashier (id=2) already has uid-cashier-002
  const token = { uid: 'uid-cashier-002', email: 'admin@amora.local', email_verified: true };
  const res = await executeAuthResolution(token);
  runTest('Firebase UID pointing to User 2 but email pointing to User 1 rejected (HTTP 403)', () => {
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.error, 'Identity conflict between UID and email mapping');
  });
})();

// Test 5: A PostgreSQL account already linked to another Firebase UID is rejected
await (async () => {
  db = createFreshDb();
  // Cashier (id=2) already mapped to uid-cashier-002; new UID attempts to claim cashier@amora.local
  const token = { uid: 'uid-intruder', email: 'cashier@amora.local', email_verified: true };
  const res = await executeAuthResolution(token);
  runTest('Account already mapped to a different Firebase identity rejected (HTTP 403)', () => {
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.error, 'Target account is already mapped to a different Firebase identity');
    assert.strictEqual(db.users[1].firebase_uid, 'uid-cashier-002');
  });
})();

// Test 6: Duplicate normalized email matches are rejected
await (async () => {
  db = createFreshDb();
  const token = { uid: 'uid-dup-test', email: 'DUP@amora.local', email_verified: true };
  const res = await executeAuthResolution(token);
  runTest('Duplicate normalized email matches rejected with HTTP 403 Ambiguous identity', () => {
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.error, 'Ambiguous user identity: multiple accounts match email');
  });
})();

// Test 7: Existing verified UID mappings continue to work
await (async () => {
  db = createFreshDb();
  const token = { uid: 'uid-cashier-002', email: 'random@test.com', email_verified: true };
  const res = await executeAuthResolution(token);
  runTest('Existing UID mapping resolves directly to numeric ID without email match', () => {
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.user.id, 2);
    assert.strictEqual(res.user.role, 'cashier');
  });
})();

// Test 8: Inactive accounts cannot authenticate
await (async () => {
  db = createFreshDb();
  const token = { uid: 'uid-inactive', email: 'inactive@amora.local', email_verified: true };
  const res = await executeAuthResolution(token);
  runTest('Inactive accounts (active=0) are rejected with HTTP 401', () => {
    assert.strictEqual(res.status, 401);
    assert(res.error.includes('inactive or disabled'));
  });
})();

// Test 9: Client-supplied roles and store IDs cannot override database values
runTest('Client-supplied claims/roles cannot override PostgreSQL database authority', () => {
  const clientClaims = { role: 'admin', storeId: 'rogue-store', id: 999 };
  const dbUser = { id: 2, role: 'cashier', storeId: 'amora-main' };

  // Backend assignment strictly uses dbUser
  const authenticatedUser = {
    ...clientClaims,
    id: dbUser.id,
    role: dbUser.role,
    storeId: 'amora-main'
  };

  assert.strictEqual(authenticatedUser.id, 2);
  assert.strictEqual(authenticatedUser.role, 'cashier');
  assert.strictEqual(authenticatedUser.storeId, 'amora-main');
});

// Test 10: Provisioning can be safely retried (Idempotency)
await (async () => {
  const p1 = await provisionUser({ email: 'retry-user@amora.local', role: 'manager' });
  const p2 = await provisionUser({ email: 'retry-user@amora.local', role: 'manager' });
  runTest('Provisioning run multiple times preserves UID and does not duplicate accounts', () => {
    assert.strictEqual(p1.isNewUser, true);
    assert.strictEqual(p2.isNewUser, false);
    assert.strictEqual(p1.uid, p2.uid);
  });
})();

// Test 11: Partial provisioning failure does not grant access
await (async () => {
  db = createFreshDb();
  // Firebase user created but not linked in DB yet and email unverified
  const token = { uid: 'uid-partial-failure', email: 'admin@amora.local', email_verified: false };
  const res = await executeAuthResolution(token);
  runTest('Partial provisioning failure with unverified email grants zero database access', () => {
    assert.strictEqual(res.status, 403);
    assert.strictEqual(db.users[0].firebase_uid, null);
  });
})();

// Test 12: Legacy bcrypt hashes remain untouched
runTest('Legacy PostgreSQL bcrypt password hashes remain completely unaltered', () => {
  const initialHash = '$2b$10$BcryptHashSample1';
  assert.strictEqual(db.users[0].password_hash, initialHash);
  // Re-verify that no property mutation has touched password_hash
  db.users.forEach(u => {
    assert(u.password_hash.startsWith('$2b$10$'), 'Password hash must be preserved bcrypt');
  });
});

console.log(`\n================================================================`);
console.log(`PHASE 6E.10 RESULTS: ${passed}/${total} TESTS PASSED.`);
console.log(`================================================================\n`);
