'use client';

import type { E2EEKeyMaterial } from './protocol';

const DB_NAME = 'synapsis-e2ee';
const DB_VERSION = 1;
const STORE_NAME = 'account-keys';

interface PersistedKeyRecord {
  keyId: string;
  publicKey: string;
  wrappingKey: CryptoKey;
  ciphertext: ArrayBuffer;
  iv: ArrayBuffer;
  updatedAt: number;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME);
      }
    };
  });
}

async function readValue<T>(key: string): Promise<T | null> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readonly');
    const request = transaction.objectStore(STORE_NAME).get(key);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve((request.result as T | undefined) ?? null);
  });
}

async function writeValue(key: string, value: unknown): Promise<void> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
    transaction.oncomplete = () => resolve();
    transaction.objectStore(STORE_NAME).put(value, key);
  });
}

async function deleteValue(key: string): Promise<void> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
    transaction.oncomplete = () => resolve();
    transaction.objectStore(STORE_NAME).delete(key);
  });
}

function wrappingKeyName(did: string): string {
  return `wrapping:${did}`;
}

function materialName(did: string): string {
  return `material:${did}`;
}

export async function persistE2EEKeyMaterial(did: string, material: E2EEKeyMaterial): Promise<void> {
  const existingRecord = await readValue<Partial<PersistedKeyRecord>>(materialName(did));
  const legacyWrappingKey = existingRecord?.wrappingKey
    ? null
    : await readValue<CryptoKey>(wrappingKeyName(did));
  const wrappingKey = existingRecord?.wrappingKey
    || legacyWrappingKey
    || await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(material));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(`${did}:${material.keyId}`) },
    wrappingKey,
    encoded,
  );

  // The wrapping key and the payload it encrypts must be committed together.
  // If two first-time writes race, either complete record can win without
  // leaving one writer's ciphertext paired with the other writer's key.
  await writeValue(materialName(did), {
    keyId: material.keyId,
    publicKey: material.publicKey,
    wrappingKey,
    ciphertext,
    iv: iv.buffer.slice(iv.byteOffset, iv.byteOffset + iv.byteLength) as ArrayBuffer,
    updatedAt: Date.now(),
  } satisfies PersistedKeyRecord);
}

export async function restoreE2EEKeyMaterial(did: string): Promise<E2EEKeyMaterial | null> {
  try {
    const record = await readValue<Partial<PersistedKeyRecord>>(materialName(did));
    const wrappingKey = record?.wrappingKey
      || await readValue<CryptoKey>(wrappingKeyName(did));
    if (!wrappingKey || !record) return null;
    if (!record.keyId || !record.publicKey || !record.iv || !record.ciphertext) return null;

    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: new Uint8Array(record.iv),
        additionalData: new TextEncoder().encode(`${did}:${record.keyId}`),
      },
      wrappingKey,
      record.ciphertext,
    );
    const material = JSON.parse(new TextDecoder().decode(plaintext)) as E2EEKeyMaterial;
    if (material.keyId !== record.keyId || material.publicKey !== record.publicKey) return null;
    return material;
  } catch {
    return null;
  }
}

export async function clearE2EEKeyMaterial(did: string): Promise<void> {
  await Promise.all([
    deleteValue(materialName(did)),
    deleteValue(wrappingKeyName(did)),
  ]);
}
