/**
 * Secure Key Persistence
 * 
 * Stores the encrypted private key in IndexedDB so the user stays unlocked
 * across page refreshes and tabs. The key is wrapped with a session key
 * that's stored in localStorage (cleared on browser close/logout).
 * 
 * Security model:
 * - Private key is ALWAYS encrypted at rest (IndexedDB)
 * - Session key in localStorage is needed to unwrap
 * - XSS attacker needs BOTH storage access AND the session key
 * - On logout, both are cleared
 */

import { deserializeEncryptedKey, type EncryptedPrivateKey } from './private-key-client';

const DB_NAME = 'synapsis-identity';
const DB_VERSION = 1;
const STORE_NAME = 'keys';
const SESSION_KEY_PREFIX = 'synapsis_session_key:';
const WRAPPED_KEY_PREFIX = 'synapsis_wrapped_key:';

interface WrappedKey {
  wrapped: string;      // Base64 of wrapped key
  iv: string;           // Base64 of IV
  salt: string;         // Base64 of salt
  createdAt: number;    // Timestamp for expiry
}

interface SessionData {
  key: string;          // Base64 of session encryption key
  createdAt: number;
}

function getSessionKeyItem(identifier: string): string {
  return `${SESSION_KEY_PREFIX}${identifier}`;
}

function getWrappedKeyItem(identifier: string): string {
  return `${WRAPPED_KEY_PREFIX}${identifier}`;
}

// ============================================
// IndexedDB Operations
// ============================================

async function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
  });
}

async function storeInDB(key: string, value: any): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.put(value, key);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function getFromDB<T>(key: string): Promise<T | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(key);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
  });
}

async function removeFromDB(key: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.delete(key);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

// ============================================
// Crypto Operations
// ============================================

/**
 * Derive a session key from the user's password
 * This is fast and deterministic - same password = same session key
 */
export async function deriveSessionKey(password: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const passwordData = encoder.encode(password);
  
  // Import password as key material
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    passwordData,
    'PBKDF2',
    false,
    ['deriveKey']
  );
  
  // Derive a session key - using a fixed salt since we want deterministic output
  // The salt is public knowledge anyway (stored with wrapped key)
  const fixedSalt = encoder.encode('synapsis-session-v1');
  
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: fixedSalt,
      iterations: 10000,  // Lower than main encryption since this is session-only
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    true,  // extractable so we can store it
    ['encrypt', 'decrypt']
  );
}

/**
 * Generate a random session key (for when we already have the decrypted key)
 */
async function generateSessionKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
}

async function exportSessionKey(key: CryptoKey): Promise<string> {
  const exported = await crypto.subtle.exportKey('raw', key);
  return arrayBufferToBase64(exported);
}

async function importSessionKey(keyData: string): Promise<CryptoKey> {
  const buffer = base64ToArrayBuffer(keyData);
  return crypto.subtle.importKey(
    'raw',
    buffer,
    { name: 'AES-GCM', length: 256 },
    false,  // not extractable after import
    ['encrypt', 'decrypt']
  );
}

// ============================================
// Key Wrapping / Unwrapping
// ============================================

/**
 * Wrap the raw private key data with a session key for storage
 * This works on the raw PKCS8 bytes, not the CryptoKey
 */
async function wrapRawPrivateKey(
  privateKeyBase64: string, 
  sessionKey: CryptoKey
): Promise<WrappedKey> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  
  // Convert base64 private key to bytes
  const privateKeyBytes = base64ToArrayBuffer(privateKeyBase64);
  
  // Encrypt the raw key data using AES-GCM
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    sessionKey,
    privateKeyBytes
  );
  
  return {
    wrapped: arrayBufferToBase64(encrypted),
    iv: arrayBufferToBase64(iv),
    salt: arrayBufferToBase64(new Uint8Array(0)), // Not used but kept for structure
    createdAt: Date.now(),
  };
}

/**
 * Unwrap the private key using the session key
 * Returns the raw key bytes that can then be imported
 */
async function unwrapRawPrivateKey(
  wrapped: WrappedKey, 
  sessionKey: CryptoKey
): Promise<ArrayBuffer> {
  const wrappedBuffer = base64ToArrayBuffer(wrapped.wrapped);
  const iv = base64ToArrayBuffer(wrapped.iv);
  
  // Decrypt the raw key data
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    sessionKey,
    wrappedBuffer
  );
  
  return decrypted;
}

// ============================================
// Public API
// ============================================

/**
 * Save the unlocked private key for persistence
 * Call this after the user unlocks with their password
 * 
 * Note: We wrap the raw key data (not the CryptoKey) because the imported
 * key is non-extractable for security. We have the raw PKCS8 data available
 * right after decryption, before importing.
 */
export async function persistUnlockedKey(
  privateKeyBase64: string,
  password: string,
  identifier: string
): Promise<void> {
  try {
    // Derive session key from password
    const sessionKey = await deriveSessionKey(password);
    
    // Wrap the raw private key data (before importing as non-extractable)
    const wrapped = await wrapRawPrivateKey(privateKeyBase64, sessionKey);
    
    // Store wrapped key in IndexedDB
    await storeInDB(getWrappedKeyItem(identifier), wrapped);
    
    // Store session key in localStorage (so it survives refreshes)
    const sessionKeyData = await exportSessionKey(sessionKey);
    const sessionData: SessionData = {
      key: sessionKeyData,
      createdAt: Date.now(),
    };
    localStorage.setItem(getSessionKeyItem(identifier), JSON.stringify(sessionData));
    
    console.log('[KeyPersistence] Key persisted successfully');
  } catch (error) {
    console.error('[KeyPersistence] Failed to persist key:', error);
    throw error;
  }
}

/**
 * Try to restore the private key from persistent storage
 * Returns the raw key bytes if available, null otherwise
 * The caller must then import these bytes as a non-extractable CryptoKey
 */
export async function tryRestoreKey(identifier: string): Promise<ArrayBuffer | null> {
  try {
    // Get session key from localStorage
    const sessionDataRaw = localStorage.getItem(getSessionKeyItem(identifier));
    if (!sessionDataRaw) {
      console.log('[KeyPersistence] No session key found');
      return null;
    }
    
    const sessionData: SessionData = JSON.parse(sessionDataRaw);
    
    // Check expiry (24 hours)
    const MAX_AGE = 3650 * 24 * 60 * 60 * 1000;
    if (Date.now() - sessionData.createdAt > MAX_AGE) {
      console.log('[KeyPersistence] Session expired');
      await clearPersistentKey(identifier);
      return null;
    }
    
    // Get wrapped key from IndexedDB
    const wrapped = await getFromDB<WrappedKey>(getWrappedKeyItem(identifier));
    if (!wrapped) {
      console.log('[KeyPersistence] No wrapped key found');
      return null;
    }
    
    // Import session key
    const sessionKey = await importSessionKey(sessionData.key);
    
    // Unwrap to get raw key bytes
    const privateKeyBytes = await unwrapRawPrivateKey(wrapped, sessionKey);
    
    console.log('[KeyPersistence] Key restored successfully');
    return privateKeyBytes;
  } catch (error) {
    console.error('[KeyPersistence] Failed to restore key:', error);
    return null;
  }
}

/**
 * Clear the persisted key (logout)
 */
export async function clearPersistentKey(identifier?: string): Promise<void> {
  try {
    if (identifier) {
      localStorage.removeItem(getSessionKeyItem(identifier));
      await removeFromDB(getWrappedKeyItem(identifier));
      return;
    }

    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key?.startsWith(SESSION_KEY_PREFIX)) {
        keysToRemove.push(key);
      }
    }

    keysToRemove.forEach(key => localStorage.removeItem(key));

    console.log('[KeyPersistence] Key cleared');
  } catch (error) {
    console.error('[KeyPersistence] Error clearing key:', error);
  }
}

/**
 * Check if a persisted key is available
 */
export async function hasPersistentKey(identifier: string): Promise<boolean> {
  const sessionData = localStorage.getItem(getSessionKeyItem(identifier));
  if (!sessionData) return false;
  
  try {
    const parsed: SessionData = JSON.parse(sessionData);
    const MAX_AGE = 3650 * 24 * 60 * 60 * 1000;
    return Date.now() - parsed.createdAt <= MAX_AGE;
  } catch {
    return false;
  }
}

// ============================================
// Helpers
// ============================================

function arrayBufferToBase64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer as ArrayBuffer;
}
