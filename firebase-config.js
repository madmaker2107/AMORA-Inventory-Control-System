import { getApps, initializeApp } from 'https://www.gstatic.com/firebasejs/12.5.0/firebase-app.js';
import { getAuth, browserLocalPersistence, browserSessionPersistence, setPersistence } from 'https://www.gstatic.com/firebasejs/12.5.0/firebase-auth.js';
import { getFirestore } from 'https://www.gstatic.com/firebasejs/12.5.0/firebase-firestore.js';

// Public Firebase Web SDK client configuration for project amora-6134f
const defaultPublicFirebaseConfig = {
  apiKey: 'AIzaSyA2cs2CXo6_Bx-FeI6ZDZ7yaViSSRJnI3Y',
  authDomain: 'amora-6134f.firebaseapp.com',
  projectId: 'amora-6134f',
  storageBucket: 'amora-6134f.firebasestorage.app',
  messagingSenderId: '112398565685',
  appId: '1:112398565685:web:6cb7296857b37286570c7c'
};

let firebaseConfig = window.__AMORA_FIREBASE_CONFIG__ || defaultPublicFirebaseConfig;

// Dynamically fetch config if custom backend API base is configured or running locally from file://
const configUrl = window.__AMORA_API_BASE__
  ? `${window.__AMORA_API_BASE__}/firebase-config`
  : (window.location.protocol === 'file:' ? 'http://localhost:4016/api/firebase-config' : null);

if (configUrl) {
  try {
    const configResponse = await fetch(configUrl);
    if (configResponse.ok) {
      const remoteConfig = await configResponse.json();
      if (remoteConfig.apiKey && remoteConfig.projectId) {
        firebaseConfig = { ...firebaseConfig, ...remoteConfig };
      }
    }
  } catch {
    // Retain default public config
  }
}

export const firebaseEnabled = Boolean(firebaseConfig && firebaseConfig.apiKey && firebaseConfig.projectId);
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
