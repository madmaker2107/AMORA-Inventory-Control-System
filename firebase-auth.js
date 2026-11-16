import {
  createUserWithEmailAndPassword,
  onAuthStateChanged as subscribeToAuthState,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut
} from 'https://www.gstatic.com/firebasejs/12.5.0/firebase-auth.js';
import { firebaseAuth, firebaseEnabled, persistAuthSession } from './firebase-config.js';

export { firebaseEnabled };

export function onAuthStateChanged(callback) {
  return firebaseAuth ? subscribeToAuthState(firebaseAuth, callback) : () => {};
}

export async function signInWithFirebase(email, password, rememberMe) {
  if (!firebaseAuth) throw new Error('Firebase Authentication is not configured.');
  await persistAuthSession(rememberMe);
  const result = await signInWithEmailAndPassword(firebaseAuth, email, password);
  return result.user;
}

export async function registerWithFirebase(email, password, displayName) {
  if (!firebaseAuth) throw new Error('Firebase Authentication is not configured.');
  const result = await createUserWithEmailAndPassword(firebaseAuth, email, password);
  await sendEmailVerification(result.user);
  return result.user;
}

export async function resetFirebasePassword(email) {
  if (!firebaseAuth) throw new Error('Firebase Authentication is not configured.');
  return sendPasswordResetEmail(firebaseAuth, email);
}

export async function logoutFromFirebase() {
  if (firebaseAuth) await signOut(firebaseAuth);
}
