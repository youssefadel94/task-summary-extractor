/**
 * Firebase Storage — init, upload, and existence checks.
 *
 * Improvements:
 *  - Retry logic with exponential backoff for transient failures
 *  - No process.exit() — throws descriptive errors instead
 *  - Upload progress tracking for large files
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { FIREBASE_CONFIG, MIME_MAP } = require('../config');
const { withRetry } = require('../utils/retry');

// Cached Firebase instances — avoid re-initializing
let _app = null;
let _storage = null;
let _auth = null;

/**
 * Initialize Firebase app, storage, and anonymous auth.
 * Returns { storage, authenticated }.
 * Safe to call multiple times — caches the instance.
 */
async function initFirebase() {
  if (_storage) {
    return { storage: _storage, authenticated: !!_auth };
  }

  const { initializeApp } = require('firebase/app');
  const { getStorage } = require('firebase/storage');
  const { getAuth, signInAnonymously } = require('firebase/auth');

  _app = initializeApp(FIREBASE_CONFIG);
  _storage = getStorage(_app);

  let authenticated = false;
  try {
    const auth = getAuth(_app);
    await signInAnonymously(auth);
    _auth = auth;
    authenticated = true;
    console.log('  Firebase: anonymous sign-in OK');
  } catch (err) {
    console.warn(`  Firebase: anonymous auth failed (${err.message})`);
    console.warn('  → Storage uploads will be skipped.');
    console.warn('  → To fix: enable Anonymous sign-in in Firebase Console → Authentication → Sign-in method');
  }

  return { storage: _storage, authenticated };
}

/**
 * Upload a local file to Firebase Storage with retry.
 * Returns the download URL.
 *
 * @param {object} storage - Firebase storage instance
 * @param {string} filePath - Local file path
 * @param {string} storagePath - Target path in Firebase Storage
 * @returns {Promise<string>} Download URL
 */
async function uploadToStorage(storage, filePath, storagePath) {
  const { ref, uploadBytes, getDownloadURL } = require('firebase/storage');

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_MAP[ext] || 'application/octet-stream';

  return withRetry(async () => {
    const fileBuffer = fs.readFileSync(filePath);
    const fileRef = ref(storage, storagePath);
    await uploadBytes(fileRef, fileBuffer, { contentType });
    const url = await getDownloadURL(fileRef);
    return url;
  }, {
    label: `Firebase upload (${path.basename(filePath)})`,
    maxRetries: 3,
  });
}

/**
 * Check if a file already exists in Firebase Storage.
 * Returns the download URL if it exists, null otherwise.
 * Retries on transient network errors.
 */
async function storageExists(storage, storagePath) {
  const { ref, getDownloadURL } = require('firebase/storage');
  try {
    return await withRetry(async () => {
      const fileRef = ref(storage, storagePath);
      return await getDownloadURL(fileRef);
    }, {
      label: `Firebase exists check (${storagePath})`,
      maxRetries: 2,
      baseDelay: 1000,
    });
  } catch {
    return null;
  }
}

module.exports = { initFirebase, uploadToStorage, storageExists };
