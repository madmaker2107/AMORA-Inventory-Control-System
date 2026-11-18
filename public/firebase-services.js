import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  where
} from 'https://www.gstatic.com/firebasejs/12.5.0/firebase-firestore.js';
import { firestore } from './firebase-config.js';

function requireFirestore() {
  if (!firestore) throw new Error('Firebase is not configured. Add the Firebase environment variables and restart the server.');
  return firestore;
}

export async function addRecord(collectionName, data) {
  return addDoc(collection(requireFirestore(), collectionName), { ...data, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
}

export async function getRecord(collectionName, id) {
  const snapshot = await getDoc(doc(requireFirestore(), collectionName, id));
  return snapshot.exists() ? { id: snapshot.id, ...snapshot.data() } : null;
}

export async function listRecords(collectionName, { filters = [], sortBy = 'createdAt', max = 100 } = {}) {
  const constraints = filters.map(([field, operator, value]) => where(field, operator, value));
  if (sortBy) constraints.push(orderBy(sortBy, 'desc'));
  constraints.push(limit(max));
  const snapshot = await getDocs(query(collection(requireFirestore(), collectionName), ...constraints));
  return snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
}

export async function updateRecord(collectionName, id, data) {
  return updateDoc(doc(requireFirestore(), collectionName, id), { ...data, updatedAt: serverTimestamp() });
}

export async function deleteRecord(collectionName, id) {
  return deleteDoc(doc(requireFirestore(), collectionName, id));
}

export function subscribeToRecords(collectionName, callback, options = {}) {
  const { filters = [], sortBy = 'createdAt', max = 100 } = options;
  const constraints = filters.map(([field, operator, value]) => where(field, operator, value));
  if (sortBy) constraints.push(orderBy(sortBy, 'desc'));
  constraints.push(limit(max));
  return onSnapshot(query(collection(requireFirestore(), collectionName), ...constraints), (snapshot) => {
    callback(snapshot.docs.map((item) => ({ id: item.id, ...item.data() })));
  });
}
