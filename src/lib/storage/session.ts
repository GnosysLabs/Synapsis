import crypto from 'crypto';
import { cookies } from 'next/headers';
import type { users } from '@/db';
import { decryptS3Credentials, type StorageProvider } from '@/lib/storage/s3';

const STORAGE_SESSION_COOKIE = 'synapsis_storage_sessions';
const STORAGE_SESSION_TTL_MS = 3650 * 24 * 60 * 60 * 1000;

interface StorageSessionPayload {
  userId: string;
  provider: StorageProvider;
  endpoint: string | null;
  publicBaseUrl: string | null;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  expiresAt: number;
}

type StorageSessionMap = Record<string, StorageSessionPayload>;

function getEncryptionKey(): Buffer {
  const secret = process.env.AUTH_SECRET;

  if (!secret || secret.length < 16) {
    throw new Error('AUTH_SECRET is not configured for storage sessions');
  }

  return crypto.createHash('sha256').update(secret).digest();
}

function encryptPayload(payload: StorageSessionPayload): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([iv, tag, encrypted]).toString('base64url');
}

function decryptPayload(token: string): StorageSessionPayload {
  const key = getEncryptionKey();
  const raw = Buffer.from(token, 'base64url');

  if (raw.length < 29) {
    throw new Error('Invalid storage session token');
  }

  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const encrypted = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]).toString('utf8');

  return JSON.parse(decrypted) as StorageSessionPayload;
}

function encryptPayloadMap(payload: StorageSessionMap): string {
  return encryptPayload(payload as unknown as StorageSessionPayload);
}

function decryptPayloadMap(token: string): StorageSessionMap {
  return decryptPayload(token) as unknown as StorageSessionMap;
}

async function readStorageSessionMap(): Promise<StorageSessionMap> {
  const cookieStore = await cookies();
  const token = cookieStore.get(STORAGE_SESSION_COOKIE)?.value;

  if (!token) {
    return {};
  }

  try {
    const payload = decryptPayloadMap(token);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      await clearStorageSession();
      return {};
    }

    return payload;
  } catch {
    await clearStorageSession();
    return {};
  }
}

async function writeStorageSessionMap(payload: StorageSessionMap): Promise<void> {
  const cookieStore = await cookies();

  if (Object.keys(payload).length === 0) {
    cookieStore.delete(STORAGE_SESSION_COOKIE);
    return;
  }

  const maxExpiresAt = Math.max(...Object.values(payload).map(session => session.expiresAt));

  cookieStore.set(STORAGE_SESSION_COOKIE, encryptPayloadMap(payload), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    expires: new Date(maxExpiresAt),
  });
}

export async function createStorageSession(
  user: typeof users.$inferSelect,
  password: string
): Promise<StorageSessionPayload | null> {
  if (
    !user.storageProvider ||
    !user.storageAccessKeyEncrypted ||
    !user.storageSecretKeyEncrypted ||
    !user.storageBucket
  ) {
    await clearStorageSession(user.id);
    return null;
  }

  const { accessKeyId, secretAccessKey } = decryptS3Credentials(
    user.storageAccessKeyEncrypted,
    user.storageSecretKeyEncrypted,
    password
  );

  const payload: StorageSessionPayload = {
    userId: user.id,
    provider: user.storageProvider as StorageProvider,
    endpoint: user.storageEndpoint,
    publicBaseUrl: user.storagePublicBaseUrl,
    region: user.storageRegion || 'us-east-1',
    bucket: user.storageBucket,
    accessKeyId,
    secretAccessKey,
    expiresAt: Date.now() + STORAGE_SESSION_TTL_MS,
  };

  const existingSessions = await readStorageSessionMap();
  existingSessions[user.id] = payload;
  await writeStorageSessionMap(existingSessions);

  return payload;
}

export async function getStorageSession(userId: string): Promise<StorageSessionPayload | null> {
  const sessions = await readStorageSessionMap();
  const payload = sessions[userId];

  if (!payload) {
    return null;
  }

  if (payload.expiresAt <= Date.now()) {
    delete sessions[userId];
    await writeStorageSessionMap(sessions);
    return null;
  }

  return payload;
}

export async function clearStorageSession(userId?: string): Promise<void> {
  if (!userId) {
    const cookieStore = await cookies();
    cookieStore.delete(STORAGE_SESSION_COOKIE);
    return;
  }

  const sessions = await readStorageSessionMap();
  if (!(userId in sessions)) {
    return;
  }

  delete sessions[userId];
  await writeStorageSessionMap(sessions);
}
