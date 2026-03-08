/**
 * User-Owned S3-Compatible Storage Utilities
 * 
 * Supports AWS S3, Cloudflare R2, Backblaze B2, Wasabi, and Contabo.
 */

import { S3Client, PutObjectCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { decryptPrivateKey, deserializeEncryptedKey } from '@/lib/crypto/private-key';

export type StorageProvider = 's3' | 'r2' | 'b2' | 'wasabi' | 'contabo';

interface S3Credentials {
  endpoint?: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

interface StorageUploadResult {
  url: string;
  key: string;
}

function buildStorageUrl(
  key: string,
  endpoint: string | null | undefined,
  publicBaseUrl: string | null | undefined,
  region: string,
  bucket: string
): string {
  if (publicBaseUrl) {
    return `${publicBaseUrl.replace(/\/$/, '')}/${key}`;
  }

  if (endpoint) {
    return `${endpoint}/${bucket}/${key}`;
  }

  return `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
}

/**
 * Decrypt S3 credentials from encrypted storage
 */
export function decryptS3Credentials(
  encryptedAccessKey: string,
  encryptedSecretKey: string,
  password: string
): { accessKeyId: string; secretAccessKey: string } {
  try {
    const accessKeyId = decryptPrivateKey(
      deserializeEncryptedKey(encryptedAccessKey),
      password
    );
    const secretAccessKey = decryptPrivateKey(
      deserializeEncryptedKey(encryptedSecretKey),
      password
    );
    return { accessKeyId, secretAccessKey };
  } catch {
    throw new Error('Invalid storage password');
  }
}

/**
 * Create S3 client from credentials
 */
function createS3Client(creds: S3Credentials): S3Client {
  return new S3Client({
    region: creds.region,
    endpoint: creds.endpoint,
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
    },
    forcePathStyle: !!creds.endpoint, // Needed for non-AWS S3-compatible services
  });
}

/**
 * Upload a file to user's S3-compatible storage
 */
export async function uploadToUserStorage(
  file: Buffer,
  filename: string,
  mimeType: string,
  provider: StorageProvider,
  endpoint: string | null,
  publicBaseUrl: string | null,
  region: string,
  bucket: string,
  encryptedAccessKey: string,
  encryptedSecretKey: string,
  password: string
): Promise<StorageUploadResult> {
  const { accessKeyId, secretAccessKey } = decryptS3Credentials(
    encryptedAccessKey,
    encryptedSecretKey,
    password
  );

  return uploadWithStorageCredentials(
    file,
    filename,
    mimeType,
    provider,
    endpoint,
    publicBaseUrl,
    region,
    bucket,
    accessKeyId,
    secretAccessKey
  );
}

export async function uploadWithStorageCredentials(
  file: Buffer,
  filename: string,
  mimeType: string,
  _provider: StorageProvider,
  endpoint: string | null,
  publicBaseUrl: string | null,
  region: string,
  bucket: string,
  accessKeyId: string,
  secretAccessKey: string
): Promise<StorageUploadResult> {
  const normalizedRegion = region || 'us-east-1';

  const s3 = createS3Client({
    endpoint: endpoint || undefined,
    region: normalizedRegion,
    accessKeyId,
    secretAccessKey,
    bucket,
  });

  const key = `synapsis/${filename}`;

  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: file,
    ContentType: mimeType,
  }));

  const url = buildStorageUrl(key, endpoint, publicBaseUrl, normalizedRegion, bucket);

  return { url, key };
}

/**
 * Test S3 credentials by attempting to head the bucket
 */
export async function testS3Credentials(
  endpoint: string | null,
  region: string,
  bucket: string,
  accessKeyId: string,
  secretAccessKey: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const s3 = createS3Client({
      endpoint: endpoint || undefined,
      region,
      accessKeyId,
      secretAccessKey,
      bucket,
    });

    // Try to check if bucket exists/is accessible
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    return { success: true };
  } catch (error: any) {
    console.error('[S3 Test] Credential test failed:', error);
    
    // Parse common errors
    if (error.name === 'Forbidden' || error.name === '403') {
      return { success: false, error: 'Access denied. Check your Access Key and Secret Key.' };
    }
    if (error.name === 'NotFound' || error.name === '404') {
      return { success: false, error: `Bucket "${bucket}" not found. Check the bucket name.` };
    }
    if (error.name === 'NoSuchBucket') {
      return { success: false, error: `Bucket "${bucket}" does not exist.` };
    }
    if (error.name === 'InvalidAccessKeyId') {
      return { success: false, error: 'Invalid Access Key ID.' };
    }
    if (error.name === 'SignatureDoesNotMatch') {
      return { success: false, error: 'Invalid Secret Access Key.' };
    }
    if (error.name === 'NetworkingError' || error.name === 'ECONNREFUSED') {
      return { success: false, error: 'Cannot connect to endpoint. Check your endpoint URL.' };
    }
    
    return { success: false, error: error.message || 'Failed to connect to storage. Please check your credentials.' };
  }
}

/**
 * Generate and upload avatar to user's S3 storage
 */
export async function generateAndUploadAvatarToUserStorage(
  handle: string,
  endpoint: string | undefined,
  publicBaseUrl: string | undefined,
  region: string,
  bucket: string,
  accessKey: string,
  secretKey: string
): Promise<string | null> {
  try {
    // 1. Fetch the avatar from DiceBear (PNG format for better compatibility)
    const dicebearUrl = `https://api.dicebear.com/9.x/bottts-neutral/png?seed=${handle}`;
    const response = await fetch(dicebearUrl);

    if (!response.ok) {
      console.error(`Failed to fetch avatar from DiceBear: ${response.statusText}`);
      return null;
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const result = await uploadWithStorageCredentials(
      buffer,
      `avatars/${handle.replace(/[^a-zA-Z0-9]/g, '')}-avatar.png`,
      'image/png',
      's3',
      endpoint || null,
      publicBaseUrl || null,
      region,
      bucket,
      accessKey,
      secretKey
    );

    return result.url;

  } catch (error) {
    console.error('Error generating/uploading avatar:', error);
    return null;
  }
}
