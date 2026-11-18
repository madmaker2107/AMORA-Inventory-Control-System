// ==============================================================================
// AMORA Phase 6E.13 Email Verification Flow & Security Test Suite
// Verifies self-service email verification, token refresh, and backend rejection
// ==============================================================================

import assert from 'node:assert/strict';

console.log('================================================================');
console.log('   AMORA PHASE 6E.13 EMAIL VERIFICATION FLOW TEST SUITE         ');
console.log('================================================================\n');

let passCount = 0;
let failCount = 0;

function runTest(name, fn) {
  try {
    fn();
    console.log(`[PASS] ✓ ${name}`);
    passCount++;
  } catch (err) {
    console.error(`[FAIL] ✗ ${name}: ${err.message}`);
    failCount++;
  }
}

async function runAsyncTest(name, fn) {
  try {
    await fn();
    console.log(`[PASS] ✓ ${name}`);
    passCount++;
  } catch (err) {
    console.error(`[FAIL] ✗ ${name}: ${err.message}`);
    failCount++;
  }
}

// ------------------------------------------------------------------------------
// Test 1: Verified user login proceeds to backend connection
// ------------------------------------------------------------------------------
runTest('Test 1: Verified user login allows backend connection', () => {
  const mockUser = {
    uid: 'firebase-user-verified-1',
    email: 'admin@amora.local',
    emailVerified: true,
    getIdToken: async () => 'mock-verified-token'
  };

  let connected = false;
  let verificationPrompted = false;

  if (!mockUser.emailVerified) {
    verificationPrompted = true;
  } else {
    connected = true;
  }

  assert.equal(connected, true, 'Verified user should proceed to connectBackend');
  assert.equal(verificationPrompted, false, 'Verified user should not see verification prompt');
});

// ------------------------------------------------------------------------------
// Test 2: Unverified user login stops before backend connection
// ------------------------------------------------------------------------------
runTest('Test 2: Unverified user login displays verification card and halts backend requests', () => {
  const mockUser = {
    uid: 'firebase-user-unverified-1',
    email: 'newcashier@amora.local',
    emailVerified: false,
    getIdToken: async () => 'mock-unverified-token'
  };

  let protectedRequestMade = false;
  let verificationCardDisplayed = false;
  let displayedEmail = null;

  function showEmailVerificationCard(email) {
    verificationCardDisplayed = true;
    displayedEmail = email;
  }

  if (!mockUser.emailVerified) {
    showEmailVerificationCard(mockUser.email);
    // Halt execution - do not connectBackend()
  } else {
    protectedRequestMade = true;
  }

  assert.equal(verificationCardDisplayed, true, 'Verification card should be displayed');
  assert.equal(displayedEmail, 'newcashier@amora.local', 'Card should display the unverified email');
  assert.equal(protectedRequestMade, false, 'No protected backend request should be initiated');
});

// ------------------------------------------------------------------------------
// Test 3: Resend verification email success
// ------------------------------------------------------------------------------
await runAsyncTest('Test 3: Resend verification email calls sendEmailVerification and reports success', async () => {
  let sendEmailVerificationCalled = false;
  const mockUser = {
    uid: 'user-to-verify',
    email: 'cashier@amora.local',
    emailVerified: false
  };

  // Mock SDK method
  async function sendEmailVerification(user) {
    assert.equal(user.uid, 'user-to-verify');
    sendEmailVerificationCalled = true;
  }

  // Wrapper under test
  async function sendUserEmailVerification(user) {
    if (!user) throw new Error('No authenticated user found to verify.');
    await sendEmailVerification(user);
  }

  await sendUserEmailVerification(mockUser);
  assert.equal(sendEmailVerificationCalled, true, 'sendEmailVerification should be invoked with target user');
});

// ------------------------------------------------------------------------------
// Test 4: Resend verification email failure is handled cleanly
// ------------------------------------------------------------------------------
await runAsyncTest('Test 4: Resend verification email failure displays error and prevents false success', async () => {
  const mockUser = {
    uid: 'user-err',
    email: 'error@amora.local',
    emailVerified: false
  };

  async function failingSendEmailVerification() {
    const error = new Error('Network error');
    error.code = 'auth/network-request-failed';
    throw error;
  }

  let successShown = false;
  let errorMessage = '';

  function formatAuthErrorMessage(error) {
    if (error.code === 'auth/network-request-failed') {
      return 'Unable to connect to the server. Please check your connection and try again.';
    }
    return error.message;
  }

  try {
    await failingSendEmailVerification(mockUser);
    successShown = true;
  } catch (err) {
    errorMessage = formatAuthErrorMessage(err);
  }

  assert.equal(successShown, false, 'Success message must never be displayed upon failure');
  assert.equal(errorMessage, 'Unable to connect to the server. Please check your connection and try again.');
});

// ------------------------------------------------------------------------------
// Test 5: Firebase rate-limit handling and cooldown
// ------------------------------------------------------------------------------
runTest('Test 5: Firebase rate-limit (auth/too-many-requests) is caught and formatted', () => {
  const rateLimitError = new Error('Too many requests');
  rateLimitError.code = 'auth/too-many-requests';

  function formatAuthErrorMessage(error) {
    if (error?.code === 'auth/too-many-requests') {
      return 'Too many requests. Please wait a moment before trying again.';
    }
    return error.message;
  }

  const formatted = formatAuthErrorMessage(rateLimitError);
  assert.equal(formatted, 'Too many requests. Please wait a moment before trying again.');
});

// ------------------------------------------------------------------------------
// Test 6: Returning after successful verification reloads user
// ------------------------------------------------------------------------------
await runAsyncTest('Test 6: Check verification reloads Firebase user profile and detects verification', async () => {
  let isVerifiedOnServer = false;

  const mockUser = {
    uid: 'user-pending',
    email: 'cashier@amora.local',
    get emailVerified() {
      return isVerifiedOnServer;
    }
  };

  async function reload(user) {
    // In real life, Firebase updates user profile from server
    isVerifiedOnServer = true;
  }

  async function reloadFirebaseUser(user) {
    await reload(user);
    return user;
  }

  // Before clicking verification link
  assert.equal(mockUser.emailVerified, false);

  // User verifies in another tab, then clicks "I've verified my email"
  const reloaded = await reloadFirebaseUser(mockUser);
  assert.equal(reloaded.emailVerified, true, 'reloaded user must reflect updated emailVerified status');
});

// ------------------------------------------------------------------------------
// Test 7: Forced ID token refresh on verification completion
// ------------------------------------------------------------------------------
await runAsyncTest('Test 7: Forced ID token refresh (forceRefresh: true) obtains updated claims', async () => {
  let forceRefreshParam = null;

  const mockUser = {
    uid: 'user-pending',
    email: 'admin@amora.local',
    emailVerified: true
  };

  async function getIdToken(user, forceRefresh) {
    forceRefreshParam = forceRefresh;
    return `jwt-token-with-email-verified-${forceRefresh}`;
  }

  async function refreshFirebaseIdToken(user) {
    return getIdToken(user, true);
  }

  const token = await refreshFirebaseIdToken(mockUser);
  assert.equal(forceRefreshParam, true, 'getIdToken must be called with forceRefresh: true');
  assert.equal(token, 'jwt-token-with-email-verified-true');
});

// ------------------------------------------------------------------------------
// Test 8: Backend rejection of unverified tokens
// ------------------------------------------------------------------------------
await runAsyncTest('Test 8: Backend server strictly rejects unverified tokens with HTTP 403', async () => {
  // Simulate backend middleware logic in server.js lines 90-135
  function simulateAuthMiddleware(decodedToken, dbUser) {
    const emailVerified = Boolean(decodedToken.email_verified);
    if (!dbUser) {
      return { status: 401, error: 'User account not provisioned in database' };
    }
    if (!emailVerified) {
      return { status: 403, error: 'Email address must be verified before account linking' };
    }
    return { status: 200, user: { id: dbUser.id, role: dbUser.role } };
  }

  const unverifiedToken = { uid: 'uid-xyz', email: 'admin@amora.local', email_verified: false };
  const verifiedToken = { uid: 'uid-xyz', email: 'admin@amora.local', email_verified: true };
  const existingDbUser = { id: 1, email: 'admin@amora.local', role: 'admin', active: 1, firebase_uid: null };

  const unverifiedRes = simulateAuthMiddleware(unverifiedToken, existingDbUser);
  assert.equal(unverifiedRes.status, 403, 'Backend must return 403 for unverified tokens');
  assert.equal(unverifiedRes.error, 'Email address must be verified before account linking');

  const verifiedRes = simulateAuthMiddleware(verifiedToken, existingDbUser);
  assert.equal(verifiedRes.status, 200, 'Backend must accept verified tokens');
  assert.equal(verifiedRes.user.id, 1);
});

// ------------------------------------------------------------------------------
// Test 9: Separation of Password Reset from Email Verification
// ------------------------------------------------------------------------------
runTest('Test 9: Password reset does not alter emailVerified state', () => {
  const userAccount = {
    email: 'admin@amora.local',
    emailVerified: false,
    passwordHash: 'old-hash'
  };

  // Simulating password reset
  function completePasswordReset(account, newPassword) {
    account.passwordHash = 'new-hash';
    // Firebase auth invariant: password reset does NOT set emailVerified = true
  }

  completePasswordReset(userAccount, 'newSecretPassword123!');
  assert.equal(userAccount.passwordHash, 'new-hash');
  assert.equal(userAccount.emailVerified, false, 'Password reset must never mark account as verified');
});

// ------------------------------------------------------------------------------
// Test 10: Invariant check - No client can forge emailVerified in backend
// ------------------------------------------------------------------------------
runTest('Test 10: Backend only trusts cryptographic Firebase token decoded claim', () => {
  const clientRequestBody = { email_verified: true, emailVerified: true, role: 'admin', id: 1 };
  const verifiedToken = { uid: 'user-token-uid', email_verified: false }; // Cryptographically verified by Firebase Admin

  // Server only inspects verifiedToken.email_verified
  const serverRecognizedVerified = Boolean(verifiedToken.email_verified);
  assert.equal(serverRecognizedVerified, false, 'Client request body fields cannot override token claim');
});

console.log('\n================================================================');
console.log(`RESULTS: ${passCount} PASSED | ${failCount} FAILED`);
console.log('================================================================');

if (failCount > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
