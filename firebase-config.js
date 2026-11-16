import { getApps, initializeApp } from 'https://www.gstatic.com/firebasejs/12.5.0/firebase-app.js';
import { getAuth, browserLocalPersistence, browserSessionPersistence, setPersistence } from 'https://www.gstatic.com/firebasejs/12.5.0/firebase-auth.js';
import { getFirestore } from 'https://www.gstatic.com/firebasejs/12.5.0/firebase-firestore.js';

const configUrl = window.__AMORA_API_BASE__
  ? `${window.__AMORA_API_BASE__}/firebase-config`
  : (window.location.protocol === 'file:' ? 'http://localhost:4016/api/firebase-config' : '/api/firebase-config');
let firebaseConfig = {};
try {
  const configResponse = await fetch(configUrl);
  firebaseConfig = configResponse.ok ? await configResponse.json() : {};
} catch {
  firebaseConfig = {};
}

export const firebaseEnabled = Boolean(firebaseConfig.apiKey && firebaseConfig.projectId);
export const firebaseApp = firebaseEnabled
  ? (getApps()[0] || initializeApp(firebaseConfig))
  : null;
export const firebaseAuth = firebaseApp ? getAuth(firebaseApp) : null;
export const firestore = firebaseApp ? getFirestore(firebaseApp) : null;
export const firebaseStorage = null;

export async function persistAuthSession(rememberMe) {
  if (firebaseAuth) {
    await setPersistence(firebaseAuth, rememberMe ? browserLocalPersistence : browserSessionPersistence);
  }
}
