# AMORA Firebase security

## Authentication

The browser uses Firebase Auth for configured environments. The Express backend verifies Firebase ID tokens with Firebase Admin SDK when a server credential is configured. Legacy SQLite/JWT login remains intentionally available during migration and is clearly reported in the login UI. A Firebase token is never accepted as a JWT: when Admin verification is configured, it is verified with Firebase; otherwise Firebase-protected API access is blocked by the backend's token verification failure.

Never accept `role`, `storeId`, or `uid` from a public registration request. Role assignment and custom claims must be performed by a trusted Admin SDK process. Public users may only create their own `users/{uid}` document as `cashier`, with the store bound to a trusted claim.

## Firestore

[firestore.rules](firestore.rules) uses explicit collection matches plus a deny-by-default recursive catch-all. It requires authentication, matches every business document to the caller's `storeId` claim, validates required fields and core types, protects the `users` collection from generic access, prevents self role/store changes, and restricts operational writes by role. Products, inventory, suppliers, purchases, batches, and stock movements require stock roles; financial and administrative records require manager/admin roles; sales and payments require cashier-capable roles; audit logs and predictions are not client-writable. Review and test rules in the Emulator Suite before deployment. Admin SDK calls bypass rules and must enforce the same checks in backend code.

## Storage

Storage is optional and disabled on Spark for this project. The browser does not initialize or request uploads unless a configured Firebase app is available. `firebaseStorage` remains an optional future module. Product images must use a placeholder when Storage is unavailable. After upgrading to Blaze, create the bucket manually, review [storage.rules](storage.rules), and add an explicit upload flow with file-size/type validation. Do not deploy or enable Storage as part of this milestone.

## Sensitive operations

Financial records, role changes, audit logs, and cross-store actions should be written through trusted backend operations. Firestore rules are defense in depth, not a substitute for backend authorization. Keep service-account JSON and private keys outside the repository and out of browser configuration.
