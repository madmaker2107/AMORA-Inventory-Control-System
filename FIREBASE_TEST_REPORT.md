# AMORA Firebase execution report

## Current Authoritative Status

This section supersedes earlier historical snapshots below. The older blocked entries are preserved for audit history and must not be interpreted as the current state.

- Firebase Admin SDK credentials and Auth initialization: PASS. Project `amora-6134f` verified.
- Test user `LIxlMVmlpWZnD1dfjx6gAVavzO23`: PASS. Account exists and is active.
- User claims: PASS. `role=admin`, `storeId=amora-main`.
- Firestore profile: PASS. `users/LIxlMVmlpWZnD1dfjx6gAVavzO23` verified.
- Isolated Firestore CRUD and realtime listener: PASS. Test document was cleaned up.
- Firebase Web SDK initialization: PASS. Current frontend config targets `amora-6134f`.
- Email/password readiness: PASS by inspection. The approved user has an email and the `password` provider linked; no sign-in request was made in this reconciliation.
- Account disabled state: PASS. The account is not disabled.
- Email verification: NOT TESTED by this run; current Admin metadata reports the account is unverified and was not changed.
- Browser Firebase login, logout, persistence, password reset, and ID-token transmission: NOT TESTED. No authentication request was made.
- `auth/too-many-requests`: BLOCKED. It was observed during an earlier browser attempt; this run did not retry, so clearance is unknown.
- Client request safety: PASS. One submit listener, one Firebase app/Auth initialization path, in-flight submit guard, disabled submit button, no automatic retry, and no silent JWT fallback when Firebase is configured.
- Firestore Security Rules enforcement: NOT TESTED against a client/emulator. Admin SDK CRUD does not prove client-side rules.
- Storage: PASS for optional startup behavior. Storage is not initialized.

### Milestone 3A Safe Verification Evidence

- JavaScript syntax and diagnostics: PASS.
- Static auth wiring: PASS. One login submit listener, one `signInWithFirebase` call, one `initializeApp` call, zero retry patterns, and no silent legacy fallback path when Firebase is configured.
- Admin account metadata: PASS. UID matches, account is active, email is available without being printed, and the `password` provider is linked.
- Authentication requests made during this run: NONE.

## Milestone 3B Invalid-Credential and Dashboard-State Diagnosis

- Live sign-in attempts: NONE. This was a static/runtime-path diagnosis only.
- Firebase error handling: `auth/invalid-credential` is displayed from the original Firebase error's `message`; only `auth/too-many-requests` is deliberately transformed into a friendly cooldown message.
- Credential input: `app.js` passes the exact email input value to `signInWithFirebase`, and `firebase-auth.js` passes it directly to `signInWithEmailAndPassword`. There is no username conversion or whitespace trimming/normalization.
- Auth instance: the Firebase Auth instance exported by `firebase-config.js` is the one used by `firebase-auth.js`.
- Stale session sources: `app.js` reads `amora_token` from `sessionStorage` first, then `localStorage`; Firebase state is held in `firebaseUser`. A stale JWT can be selected for API requests when no Firebase user exists, but it is still rejected by the backend if invalid or expired.
- Dashboard sample content: the initial dashboard is embedded in `index.html`; `dashboardMarkup` captures it before runtime data loads. The app shell remains rendered behind the fixed auth overlay, so sample cards/tables can be visible even when unauthenticated.
- Protected API behavior: `apiRequest()` parses the response and throws on any non-2xx response, so HTTP 401 cannot be treated as successful dashboard data. `connectBackend()` catches the failure, keeps the auth screen visible, and does not replace the sample markup.
- `Authentication required` source: initial `bindDashboard()` invokes `loadSalesChart()`, which calls a protected reports endpoint before authentication; its 401 is surfaced as a toast while the static dashboard remains in the DOM.
- Logout cleanup: `logout()` signs out Firebase, clears `firebaseUser`, clears both local JWT storage locations, and shows the auth screen. It does not clear `pageContent`, so previously rendered sample or dashboard data remains behind the auth screen until a reload or view replacement.
- Duplicate handlers/retries: NOT FOUND in the current static audit. One form submit listener, one Firebase sign-in call, no automatic retry path.
- Files affected by these findings: `app.js`, `firebase-auth.js`, `firebase-config.js`, `index.html`.
- Root cause of the screenshot state: unauthenticated initial/sample markup plus protected API 401 handling, not a successful authenticated dashboard response.
- Exact next step: do not retry while Firebase reports `auth/too-many-requests`; after the restriction clears, perform one controlled login with the exact account email and password. If `auth/invalid-credential` persists, verify the entered email/password in Firebase Console without changing the account from this code path.

## Milestone 3D Login-Flow Diagnosis

- Status: DIAGNOSIS COMPLETE; live sign-in was not attempted.
- Firebase client session state: OBSERVED. The browser reported `Firebase session restored`, indicating an existing persisted client session was recognized. This is not treated as proof of a new login or a newly generated token.
- Current failing stage: BACKEND AVAILABILITY. The browser's protected `/api/dashboard` request to port 4015 failed with `ERR_CONNECTION_REFUSED` because that isolated backend was not running. The request therefore did not reach Firebase Admin verification.
- Firebase ID-token generation: NOT TESTED. No token was generated, inspected, or printed by this diagnostic.
- Backend ID-token verification: NOT TESTED in this run. Admin project, claims, and profile were independently verified read-only, but no client token reached the backend.
- Claims/profile readiness: PASS by read-only Admin inspection. Project, UID, active state, `role=admin`, `storeId=amora-main`, and profile match were confirmed.
- Frontend token path: PASS by inspection. When `firebaseUser` exists, `apiRequest()` calls `firebaseUser.getIdToken()` and sends `Authorization: Bearer <token>`; stored JWT is not selected in that branch.
- Protected response handling: PASS by inspection. Non-2xx responses throw; dashboard restoration occurs only after successful `/api/dashboard` data.
- Dashboard restoration: PASS by inspection. `connectBackend()` unlocks the shell only after the protected dashboard request succeeds.
- Invalid/stale session handling: PASS for 401/403 by inspection; network failures currently keep the Firebase session but leave the login screen visible. The current observed network failure was connection refusal, not a token rejection.
- Earlier `auth/invalid-credential` and `auth/too-many-requests`: NOT re-tested. No authentication request was made.
- Recommended next step: start the backend on the same origin/port serving the frontend, then perform one approved controlled login attempt. Only that test can distinguish Firebase credential acceptance from backend token verification.

## Milestone 3E Backend Connectivity Verification

- Intended development port: PASS by configuration. Root `.env` specifies `PORT=4000`; `backend/package.json` uses `npm start` -> `node server.js`.
- Port 4000 status: BLOCKED by a pre-existing Node process. `/api/health` responds, but `/api/firebase-config` returns `Cannot GET`, identifying that process as a stale/non-current backend instance. It was not terminated.
- Current backend startup: PASS. The current backend was started with the existing `cd backend; npm start` command on isolated port 4016 because port 4000 was occupied.
- Firebase Admin initialization: PASS by prior credentialed initialization and current server startup with the configured Admin environment. No credentials were printed.
- Health check on current backend: PASS, HTTP 200.
- Public Firebase config on current backend: PASS. Project `amora-6134f`; exactly the six public fields; no secret fields exposed.
- Frontend API base: PASS by inspection. HTTP pages use same-origin `/api`, so the frontend must be opened from the running backend origin.
- Same-origin browser check on `http://localhost:4016`: PASS. Firebase status was ready, login screen visible, dashboard shell hidden, no `/api/dashboard` connection-refused failure, and no JavaScript page errors. No login was attempted.
- Actual browser login and Firebase ID-token backend verification: NOT TESTED.
- Current action: backend on port 4016 remains running for the next controlled browser test. The configured port was not changed; 4016 is an isolated runtime override only.

## Milestone 3F Live Firebase Authentication Verification

- Status: PASS.
- Browser Firebase authentication state: PASS. The existing browser session reported a Firebase user and the AMORA auth screen was hidden while the app shell was visible.
- UID verification: PASS. Current Firebase UID matched `LIxlMVmlpWZnD1dfjx6gAVavzO23`.
- Firebase ID-token acquisition: PASS. `getIdToken()` returned a token object successfully; the token value was not printed or stored in the report.
- Claims verification: PASS. ID-token claims contained `role=admin` and `storeId=amora-main`.
- Backend protected request: PASS. Browser request to `GET /api/dashboard` returned HTTP 200 using the Firebase bearer token.
- Backend token validation: PASS by end-to-end evidence. The protected request reached the running backend and returned dashboard data; Admin SDK was initialized for `amora-6134f`.
- Protected data: PASS. Dashboard response contained metrics and low-stock data; observed metrics included six products, stock value 406, and one low-stock item.
- Browser console/network: PASS. No page errors or failed network requests were observed during verification.
- Legacy JWT fallback: PASS. Firebase was configured, the request used the Firebase user token path, and neither `localStorage` nor `sessionStorage` contained an `amora_token`.
- Credentials, claims, account state, and inventory data: unchanged.

## Milestone 3G Session Persistence and Logout

- Refresh persistence: PASS. After browser refresh, Firebase restored the approved UID, the protected `/api/dashboard` request returned HTTP 200, dashboard data was present, and no requests failed.
- Pre-auth dashboard flash: PASS by observed state. The restored session path ended with the app shell unlocked only after the protected dashboard response; the unauthenticated shell remains locked by the 3C state isolation.
- Logout: PASS. Existing AMORA logout flow was used with its confirmation dialog.
- Firebase session after logout: PASS by observed application state. The auth screen became visible and the app shell returned to `auth-locked`.
- Application auth state after logout: PASS. `localStorage` and `sessionStorage` contained no `amora_token`; page content length was `0`.
- Direct protected API after logout: PASS. Browser request to `/api/dashboard` without a token returned HTTP 401.
- Browser back navigation: NOT TESTED as a meaningful history case in this direct-origin test page; the logged-out reload state is locked and contains no dashboard DOM.
- Expired/revoked token handling: NOT TESTED with a real expired or revoked Firebase token. 401/403 clearing behavior remains implemented and previously inspected.
- Login again: BLOCKED pending manual credential entry. No password was requested or recorded in chat.

### Milestone 3G Re-login Completion

- Login again: PASS. The user completed the browser login manually; the password was not read or recorded by the diagnostic.
- Firebase session after re-login: PASS. Current Firebase user was present and UID matched `LIxlMVmlpWZnD1dfjx6gAVavzO23`.
- ID-token acquisition: PASS. `getIdToken()` succeeded without exposing the token.
- Claims: PASS. `role=admin`, `storeId=amora-main`.
- Protected dashboard: PASS. Browser request returned HTTP 200 and protected dashboard data was present.
- UI restoration: PASS. Auth screen hidden, app shell visible, and dashboard content restored.
- Console/network: PASS. No page errors or failed requests observed.
- Expired/revoked-token handling: NOT TESTED.
- Meaningful browser back-navigation history after logout: NOT TESTED.

## Milestone 3I Backend Port and Startup Cleanup

- Authoritative AMORA development port: `4016`.
- Root `.env`: updated to `PORT=4016`.
- Backend startup command: `cd backend; npm start`.
- Port 4000 owner: PID `23624`, `C:\Program Files\nodejs\node.exe`, command line `node server.js`, launched by `cmd.exe`. Its working-directory metadata did not identify this workspace, and it previously lacked `/api/firebase-config`; it was treated as stale/unrelated and was not terminated.
- Current AMORA listener: exactly one listener on port 4016, running `node server.js`.
- Port conflict handling: PASS by code inspection. `EADDRINUSE` now emits a clear AMORA-specific message and exits with failure instead of creating another listener.
- Frontend routing: PASS. HTTP pages use same-origin `/api`; file-mode pages target `http://localhost:4016/api`.
- Health: PASS on port 4016.
- Firebase config: PASS on port 4016; project `amora-6134f`, six public fields.
- Authenticated dashboard: PASS. Existing Firebase session reached `/api/dashboard` with HTTP 200 and protected data present.
- Credentials/auth logic: unchanged except port wiring and startup error handling.
- Multiple backend instances launched by this cleanup: NO. The existing port 4000 process was not terminated.

## Milestone 3H Firestore Security Rules Audit

- Rule implementation: PASS by structural inspection. The broad wildcard was replaced with explicit collection matches and a deny-by-default recursive catch-all.
- Authentication requirement: PASS by inspection. Business access functions require `request.auth` and a trusted `storeId` claim.
- Store isolation: PASS by inspection. Reads and writes require document `storeId` to match `request.auth.token.storeId`; updates also preserve the existing store ID.
- User self-escalation: PASS by inspection. Self-created profiles are restricted to `cashier`; self-updates require unchanged `role`, `storeId`, `uid`, `email`, and `active` fields. User deletion is denied.
- Required fields/types: PASS by structural inspection. Collection validators require common timestamps/store IDs plus core string, integer, boolean, list, and timestamp fields.
- Role restrictions: PASS by inspection. Stock operations require stock-capable roles; sales/payments require cashier-capable roles; financial/admin records require manager/admin roles; audit logs and AI predictions are client read-only.
- Unauthenticated access: PASS by inspection; no explicit unauthenticated allow exists.
- Cross-store access: PASS by inspection; mismatched store IDs fail the shared access functions.
- Emulator execution: BLOCKED. Firebase CLI/Emulator configuration is not available in this workspace.
- Live rules deployment: NOT PERFORMED. No rules were deployed and no production data was modified.
- Admin SDK rule coverage: NOT TESTED by design. Prior Admin SDK CRUD does not exercise Security Rules.
- Required next validation: run Firebase Emulator Suite with authenticated admin, cashier, stock-manager, cross-store, and unauthenticated test contexts before deployment.

## Milestone 3C Secure Unauthenticated Dashboard State

- Status: PASS for unauthenticated state isolation; live authenticated dashboard remains NOT TESTED.
- Files changed: `index.html`, `app.js`, `FIREBASE_TEST_REPORT.md`.
- Initial app shell: PASS. The shell starts with `auth-locked` and is hidden until a protected `/api/dashboard` request succeeds.
- Initial protected content: PASS. When no token or Firebase user exists, `pageContent` is cleared from the DOM after handlers are bound; the saved template remains only in memory for post-auth restoration.
- Protected API gate: PASS by inspection. Dashboard restoration and shell unlock happen only after `apiRequest('/dashboard')` returns a successful response. Non-2xx responses throw before any dashboard data is applied.
- 401/403 handling: PASS by inspection. Invalid sessions clear Firebase state, stored JWT tokens, cart state, and page content, then return to the login screen.
- Logout cleanup: PASS by inspection. Firebase sign-out, sessionStorage/localStorage token removal, in-memory cart reset, page-content clearing, and shell locking are centralized in `clearAuthenticatedState()`.
- Logged-out browser validation: PASS. Auth screen visible, app shell hidden, page content length `0`, no dashboard headings, and no JavaScript page errors. No login was submitted.
- Existing design: PRESERVED. The dashboard template and styling remain unchanged after authentication; only its locked visibility/state was changed.
- Firebase login: NOT TESTED. No authentication request was made.

## Milestone 3A Email Verification Handling

- Sign-in gate: PASS by inspection. The frontend does not block or redirect an authenticated Firebase user when `emailVerified` is false; `connectBackend()` is still called.
- Restored-session gate: PASS by inspection. `onAuthStateChanged` displays a pending-verification status but still calls `connectBackend()` for an authenticated user.
- Verification message: PASS by inspection. The login path shows a toast for an unverified user, while the auth status reports that email verification is pending.
- Resend-verification control: NOT IMPLEMENTED. No resend button or UI action exists.
- Automatic verification email: NOT SENT. `sendEmailVerification` exists only in the unused `registerWithFirebase` helper; there is no registration UI or automatic call for the existing user.
- Live sign-in behavior with the unverified account: NOT TESTED. No Firebase authentication request was made.
- Recommended next step: wait for the `auth/too-many-requests` restriction to clear, then perform one controlled login attempt. Decide separately whether AMORA should require verified email before dashboard access; that policy is not currently enforced.

### Milestone 3A Readiness

- Frontend initialization ready: PASS.
- Firebase account configuration ready: PASS by Admin inspection.
- Browser login ready to attempt: BLOCKED by the previously observed temporary Firebase throttle; no retry was performed.
- Production readiness: NOT TESTED.

## Historical Loop 1: baseline audit

- Status: COMPLETED AND VERIFIED for local inspection and syntax checks.
- Found: browser Firebase modules and backend Admin integration existed; root environment loading, explicit auth state, rule isolation, and requested reports were incomplete.
- Blocked: live Firebase Auth/Firestore tests require configured Web SDK variables, a real Firebase user, Admin credentials, or the Emulator Suite.

## Historical Loop 2: local fixes and regression checks

- Status: IMPLEMENTED BUT NOT VERIFIED for live Firebase behavior.
- Changes: root `.env` loading, explicit auth status and email verification messaging, collection-scoped Firestore rules, schema and security documentation.
- Tests executed: JavaScript syntax checks, backend health/config endpoints, legacy login, protected dashboard request.
- Passed: local server boot, health response, public config response, seeded admin login, protected SQLite dashboard.
- Not run: production Firestore reads/writes, Firebase ID-token verification, rule enforcement against a live project, password reset email, refresh persistence in a real browser, or Storage upload.

## Historical Loop 3: manual integration gate (superseded)

- Status: PARTIALLY COMPLETED; live Firebase account and Admin verification checks remain BLOCKED BY MANUAL ACTION.
- Verified locally: backend health and public config returned 200; configured project ID is `amora-6134f`; all six public fields are present and no secret fields are exposed; unauthenticated and invalid-token protected requests returned 401; legacy admin JWT login returned `admin`; protected dashboard returned six products.
- Required: populate `.env` with the Firebase Web SDK values; configure Firebase Admin Application Default Credentials or a secure service-account secret; create a Firebase Auth test user; create its trusted `users/{uid}` record and role/store claim; run Emulator Suite or approve isolated test writes.
- No production records were created and no rules were deployed.

## Historical Loop 4: configured frontend and regression verification

- Status: COMPLETED AND VERIFIED for configuration and startup behavior; live user authentication remains BLOCKED BY MANUAL ACTION.
- Found and fixed: the Firebase auth-state listener was called without the `firebaseAuth` instance, leaving the login screen stuck at `Checking authentication...`.
- Passed: browser Firebase initialization, Auth and Firestore module loading, configured project ID, exact six-field public config response, no Storage SDK request, JavaScript diagnostics, syntax checks, JWT login, protected dashboard, and invalid-token rejection.
- Not run: Firebase email/password login, ID-token Admin verification, password reset email, email verification, refresh persistence, or Firestore CRUD/listener tests because no Firebase test account/Admin credential or approved live test document is configured.

## Historical completion snapshot (superseded)

Verified locally: 14 of 18 planned verification groups, approximately 78%. This percentage excludes live Firebase account, Admin credential, Firestore data, and Security Rules behavior.

## Historical live verification gate (superseded)

- Confirmed test UID: `LIxlMVmlpWZnD1dfjx6gAVavzO23`.
- Confirmed store ID: `AMORA-main`.
- Isolated test operation approved: `integration_tests/amora-live-connectivity-test` create, read, update, realtime observation, delete, and final read.
- Admin credential status: BLOCKED BY MANUAL ACTION. No `FIREBASE_SERVICE_ACCOUNT_JSON` or `GOOGLE_APPLICATION_CREDENTIALS` value is available to the current process or root `.env`.
- Confirmed intended role: `admin`.
- Role status: BLOCKED BY MANUAL ACTION until the provisioning command can access Firebase Admin credentials.
- No live Firebase authentication or Firestore operation has been claimed or executed.

## Historical Firebase Admin credential diagnostic (superseded)

- Status: BLOCKED BY MANUAL ACTION.
- Root `.env`: detected and loaded successfully.
- `GOOGLE_APPLICATION_CREDENTIALS`: not configured; no file accessibility or project metadata check was possible.
- `FIREBASE_SERVICE_ACCOUNT_JSON`: not configured; JSON validation was not applicable.
- Expected project: `amora-6134f`.
- Firebase Admin initialization: not attempted because no valid credential source was available.
- Secrets printed: none.
- Firestore documents modified: none.
- Custom claims or users provisioned: none.

## Historical Step 3/4 Safe Verification Status (superseded)

### Project Configuration

- Firebase project: `amora-6134f`.
- Web SDK environment variables: PASS. All six values are present in the root `.env`; duplicate-key check passed.
- Public configuration endpoint: PASS. `/api/firebase-config` returned exactly `apiKey`, `authDomain`, `projectId`, `storageBucket`, `messagingSenderId`, and `appId`; no backend secret fields were exposed.
- Root environment loading: PASS. `npm start` launched from `backend` and loaded the root environment.

### Firebase Authentication

- Firebase initialization: PASS. Browser startup reached `Firebase is ready`.
- Auth module loading: PASS. Firebase Auth module loaded in the browser.
- Login: NOT TESTED. No Firebase credentials were entered into the UI during this run.
- Logout: NOT TESTED with a live Firebase user.
- Password reset: NOT TESTED; no reset email was requested.
- Authentication persistence: NOT TESTED with a live Firebase session.
- Email verification: NOT TESTED with a live Firebase user.

### Backend Security

- Firebase ID-token verification: BLOCKED. Neither Admin credential source is configured.
- Missing token rejection: PASS. Protected dashboard returned HTTP 401.
- Invalid token rejection: PASS. An invalid bearer token returned HTTP 401.
- Legacy SQLite/JWT login: PASS. Seeded admin login succeeded and protected dashboard returned six products.
- Admin credential availability: BLOCKED. `GOOGLE_APPLICATION_CREDENTIALS` and `FIREBASE_SERVICE_ACCOUNT_JSON` are absent.
- Provisioning/custom claims: NOT TESTED and intentionally not executed.

### Firestore

- Schema review: PASS by inspection. Collections, store IDs, timestamps, integer paise fields, and roles are documented.
- Rules review: PASS by inspection. Unknown collections are denied, users are matched separately, role/store changes are restricted, and business documents require a matching store.
- Live reads/writes: BLOCKED. No Admin credential is available and no live document operation was authorized in this run.
- Store isolation enforcement: NOT TESTED against deployed rules.
- Realtime listener: NOT TESTED.
- Production data changed: NO.

### Firebase Storage

- Spark compatibility: PASS by inspection and browser resource check.
- Optional initialization: PASS. Storage SDK was not requested and `firebaseStorage` remains `null`.
- Placeholder fallback: IMPLEMENTED BUT NOT TESTED through an image failure interaction in this run.
- Paid services enabled: NO.

### Safe Test Results

| Check | Status | Evidence |
| --- | --- | --- |
| JavaScript syntax and diagnostics | PASS | Node checks and editor diagnostics returned no errors |
| Backend startup | PASS | `npm start` launched on isolated port 4013 |
| Health endpoint | PASS | `/api/health` returned success |
| Public Firebase config | PASS | Project `amora-6134f`, six fields, no unexpected fields |
| Missing token | PASS | HTTP 401 |
| Invalid token | PASS | HTTP 401 |
| Local JWT login/dashboard | PASS | Admin login succeeded; dashboard returned six products |
| Browser Firebase startup | PASS | Auth status `Firebase is ready` |
| Auth/Firestore module loading | PASS | Browser requested Auth and Firestore modules |
| Storage startup dependency | PASS | No Firebase Storage request |
| Firebase live login/token verification | BLOCKED | Admin credential source unavailable |
| Firestore CRUD/listener | BLOCKED | No live credential and no approved write in this run |

### Remaining Actions

1. Configure `GOOGLE_APPLICATION_CREDENTIALS` to an external service-account file, or provide `FIREBASE_SERVICE_ACCOUNT_JSON` through a secure runtime secret.
2. Run the trusted provisioning command only after confirming the UID, `storeId`, and role; do not put credentials in command-line arguments.
3. Restart the backend from the credentialed process and verify Firebase ID-token authentication.
4. Approve an isolated `integration_tests/amora-live-connectivity-test` operation before any create/update/delete test.
5. Deploy reviewed Firestore rules only with explicit approval; this run deployed nothing.

### Final Readiness

- Code foundation ready: PASS.
- Local testing ready: PASS.
- Firebase live testing ready: BLOCKED.
- Production ready: NOT TESTED.

No credentials were printed, no Admin SDK initialization was attempted, no users or claims were provisioned, no Firestore documents were modified, and no Firebase rules were deployed in this run.

## Firebase Too-Many-Requests Diagnostic

- Status: PASS for client-side request safety; BLOCKED for Firebase temporary restriction clearance.
- Observed browser error: `auth/too-many-requests` was already present before this diagnostic. No additional Firebase sign-in attempt was made.
- Duplicate login listeners: NOT FOUND. Static inspection found one `loginForm` submit listener.
- Duplicate Firebase app initialization: NOT FOUND. `firebase-config.js` uses `getApps()[0] || initializeApp(...)`.
- Automatic retries or recursive login: NOT FOUND.
- Silent JWT fallback when Firebase is configured: FIXED and PASS by inspection. Firebase failures now surface directly; legacy JWT is used only when Firebase is unavailable.
- Submit protection: FIXED. `loginInFlight` prevents duplicate submissions and the submit button is disabled with `aria-busy` during the request, then restored in `finally`.
- Friendly temporary restriction message: FIXED. `auth/too-many-requests` maps to a wait-and-try-later message with no retry.
- Browser startup after fix: PASS. Auth status reached `Firebase is ready`; login remained visible; no JavaScript page errors occurred. The only console error was the expected unauthenticated dashboard HTTP 401.
- Firebase password provider enabled in Console: NOT TESTED. This requires Firebase Console inspection; the client path uses `signInWithEmailAndPassword`.
- Temporary Firebase restriction: BLOCKED. It may still need time to clear; no further login attempt was made.
- Files changed: `app.js`, `FIREBASE_TEST_REPORT.md`.
- No credentials, tokens, accounts, claims, Firestore documents, or rules were changed.

## Historical Milestone 2 Gate: Admin SDK Credential Verification (superseded)

- Status: BLOCKED
- Root `.env`: loaded successfully.
- `GOOGLE_APPLICATION_CREDENTIALS`: not configured.
- `FIREBASE_SERVICE_ACCOUNT_JSON`: not configured.
- Credential file/JSON validation: NOT TESTED because neither source exists.
- Project ID match: NOT TESTED for Admin credentials.
- Firebase Admin initialization: NOT TESTED; correctly skipped because no valid credential source was available.
- Provisioning, custom claims, and Firestore CRUD: NOT TESTED and intentionally skipped.
- Browser Firebase authentication: NOT TESTED and intentionally deferred until this gate passes.

## Admin SDK Diagnostic Rerun

- Root `.env` loaded: PASS.
- `GOOGLE_APPLICATION_CREDENTIALS` configured: PASS.
- Referenced credential file exists: PASS.
- Referenced credential file readable: PASS.
- Credential JSON structure valid: PASS. Required service-account fields were present; contents were not printed.
- Credential project ID: `amora-6134f`.
- Credential project ID matches expected project: PASS.
- Firebase Admin SDK initialization: PASS.
- Firebase Admin Auth service available: PASS.
- `FIREBASE_SERVICE_ACCOUNT_JSON`: not configured; no fallback was needed.
- Secrets exposed: NO.
- Prohibited operations performed: NO. No users, claims, Firestore documents, or rules were changed.

## Milestone 2 Pre-approval Identity Check

- Admin SDK project: PASS, `amora-6134f`.
- Firebase Auth user lookup: PASS. UID `LIxlMVmlpWZnD1dfjx6gAVavzO23` exists and is not disabled.
- Email verification: NOT TESTED; the user is currently unverified.
- Existing custom claims: PASS inspection. No claims are currently assigned; no role or store claim was changed.
- Intended role: `admin`, supplied by the request.
- Store ID: BLOCKED pending explicit confirmation. Existing notes contain `AMORA-main`, while the current milestone explicitly flags `amora-main` as a possible alternative; no authoritative runtime configuration resolves the difference.
- Provisioning script review: PASS inspection. With explicit arguments, it calls `setCustomUserClaims` for only the supplied UID and merges only `users/{uid}`. It would set `role`, `storeId`, profile fields, and server timestamps.
- Provisioning execution: NOT TESTED and intentionally stopped before approval.
- Firestore CRUD: NOT TESTED and intentionally stopped before provisioning/approval.
- Firestore rules deployment: NOT PERFORMED.

## Milestone 2 Final Pre-provisioning Gate

- Root `.env` loaded: PASS.
- Firebase Admin project ID `amora-6134f`: PASS.
- Test UID `LIxlMVmlpWZnD1dfjx6gAVavzO23` exists: PASS.
- Test account active: PASS.
- Existing custom claims: PASS inspection; no claims currently assigned.
- Official store ID: `amora-main`, confirmed by the user for this milestone. This supersedes older `AMORA-main` report notes.
- Intended role: `admin`.
- Provisioning script scope: PASS inspection. It can modify only the supplied UID's custom claims and the matching `users/{uid}` document; it does not create users or target business collections.
- Provisioning executed: NOT TESTED; paused for explicit approval.
- Firestore CRUD executed: NOT TESTED; deferred until provisioning approval and success.
- Rules deployed: NO.

## Milestone 2 Provisioning and Firestore CRUD Result

- Provisioning status: PASS.
- Provisioned UID: `LIxlMVmlpWZnD1dfjx6gAVavzO23`.
- Custom claims verified: PASS. `role=admin`, `storeId=amora-main`.
- Firestore profile verified: PASS. `users/LIxlMVmlpWZnD1dfjx6gAVavzO23` exists with matching UID, role, store ID, and `active=true`.
- Isolated test document: `integration_tests/amora-live-connectivity-test`.
- Test run ID: `run-1794848243166`.
- Create: PASS.
- Read after create: PASS.
- Update: PASS.
- Read after update: PASS.
- Realtime listener observed the update: PASS.
- Delete: PASS.
- Final read confirmed document absence: PASS.
- Cleanup: PASS. No production collections were modified.
- Security rules status: NOT TESTED by this CRUD run. Admin SDK operations bypass Firestore Security Rules; no rules were deployed.
