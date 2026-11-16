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
const uid = args.get('--uid');
const storeId = args.get('--store-id');
const role = args.get('--role');
if (!uid || !storeId || !allowedRoles.has(role)) {
  console.error('Usage: node backend/provision-firebase-user.js --uid <uid> --store-id <storeId> --role <admin|manager|stock_manager|cashier>');
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
const user = await auth.getUser(uid);
await auth.setCustomUserClaims(uid, { ...(user.customClaims || {}), role, storeId });
await firestore.collection('users').doc(uid).set({
  uid,
  email: user.email || '',
  role,
  storeId,
  active: true,
  emailVerified: user.emailVerified,
  updatedAt: FieldValue.serverTimestamp(),
  createdAt: FieldValue.serverTimestamp()
}, { merge: true });
console.log(`Provisioned Firebase user ${uid} for store ${storeId} with role ${role}.`);
