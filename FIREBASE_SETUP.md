# AMORA Firebase setup

AMORA is a plain JavaScript frontend served by the existing Express backend. Firebase is loaded with the modular browser SDK from the official Firebase CDN. The local SQLite/JWT login remains available until Firebase Authentication and server-side token verification are configured.

## Configure the app

1. Copy `.env.example` to the project root `.env` (`C:\Users\soumi\OneDrive\Desktop\New folder\.env`).
2. Fill in the Firebase Web SDK values from Firebase Console > Project settings > Your apps. The configured project is `amora-6134f`.
3. Enable Email/Password under Authentication > Sign-in method.
4. Create a Firestore database. Do not create a Storage bucket on Spark.
5. Configure server-side verification with Application Default Credentials (`GOOGLE_APPLICATION_CREDENTIALS`) or provide `FIREBASE_SERVICE_ACCOUNT_JSON` through a secret manager. Never commit a service-account file or private key.
6. Restart the backend with `cd backend; npm start`; the server loads the root `.env` even when started from `backend` and uses the authoritative development port `4016`.

Start AMORA from the workspace with:

```powershell
cd backend
npm start
```

Open `http://localhost:4016`. Do not start a second backend instance. If the port is occupied, the server reports the conflict instead of starting another listener.

The browser requests public config from `GET /api/firebase-config`; no Firebase key is hardcoded in frontend source. The endpoint returns only `apiKey`, `authDomain`, `projectId`, `storageBucket`, `messagingSenderId`, and `appId`. Storage is not initialized and remains optional until a future Blaze upgrade.

## Firestore foundation

Collections are documented in `FIRESTORE_SCHEMA.md`. New records should include `storeId`, `createdAt`, and `updatedAt` where applicable. Use the functions in `firebase-services.js` for CRUD and real-time subscriptions.

Deploy only after reviewing the rules:

```powershell
firebase deploy --only firestore:rules
```

The rules expect a trusted `storeId` and role claim on the authenticated user. Set those claims with a trusted Admin SDK operation; never accept role or store claims from public registration.

For a one-time trusted user bootstrap, configure Admin credentials outside the repository and run:

```powershell
node backend/provision-firebase-user.js --uid <uid> --store-id <storeId> --role <admin|manager|stock_manager|cashier>
```

The command requires an explicit UID, store ID, and role. It sets the matching custom claims and merges the corresponding `users/{uid}` document. It never accepts credentials from command-line arguments.

## Test

- Local fallback: `admin@amora.local` / `amora123`.
- Firebase: create a user in Authentication, then create its `users/{uid}` document with a permitted role and `storeId` using a trusted process.
- Verify login, refresh persistence, logout, password reset, and a protected API request.
- Use the Firebase Emulator Suite before deploying rules to production.

Firebase Admin verification is disabled when no server credential is configured. In that mode Firebase client sign-in can succeed, but protected backend API calls will correctly reject the Firebase token; local JWT login remains the working fallback and is explicitly shown in the login status.
