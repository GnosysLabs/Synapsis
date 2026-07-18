/**
 * Node Keypair Management
 * 
 * Each Synapsis node has its own RSA keypair for signing swarm interactions.
 * The private key is encrypted and stored in the database.
 * The public key is exposed via /api/node for verification.
 */

import { db, nodes } from '@/db';
import { eq } from 'drizzle-orm';
import { generateKeyPair } from '@/lib/crypto/keys';
import crypto from 'crypto';

const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
let cachedKeypair: { privateKey: string; publicKey: string } | null = null;
let pendingKeypair: Promise<{ privateKey: string; publicKey: string }> | null = null;

function deriveEncryptionKey(secret: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(secret, 'node-key-salt', 32, (error, key) => {
      if (error) reject(error);
      else resolve(key as Buffer);
    });
  });
}

/**
 * Encrypt the node private key using AUTH_SECRET
 */
async function encryptPrivateKey(privateKey: string): Promise<string> {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error('AUTH_SECRET not configured');
  }

  // Derive a key from AUTH_SECRET
  const key = await deriveEncryptionKey(secret);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);

  let encrypted = cipher.update(privateKey, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag();

  // Return iv:authTag:encrypted
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

/**
 * Decrypt the node private key using AUTH_SECRET
 */
async function decryptPrivateKey(encryptedData: string): Promise<string> {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error('AUTH_SECRET not configured');
  }

  const [ivHex, authTagHex, encrypted] = encryptedData.split(':');
  const key = await deriveEncryptionKey(secret);
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');

  const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

/**
 * Get or generate the node's keypair
 * Returns the private key (decrypted) and public key
 */
async function loadNodeKeypair(): Promise<{ privateKey: string; publicKey: string }> {
  if (!db) {
    throw new Error('Database not available');
  }

  const domain = process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:43821';

  // Try to get existing node
  const node = await db.query.nodes.findFirst({
    where: { domain: domain },
  });

  // If node doesn't exist, create it
  if (!node) {
    const { publicKey, privateKey } = await generateKeyPair();
    const encryptedPrivateKey = await encryptPrivateKey(privateKey);

    await db.insert(nodes).values({
      domain,
      name: process.env.NEXT_PUBLIC_NODE_NAME || 'Synapsis Node',
      description: process.env.NEXT_PUBLIC_NODE_DESCRIPTION || 'A swarm social network node',
      publicKey,
      privateKeyEncrypted: encryptedPrivateKey,
    });

    return { privateKey, publicKey };
  }

  // If node exists but has no keys, generate them
  if (!node.publicKey || !node.privateKeyEncrypted) {
    const { publicKey, privateKey } = await generateKeyPair();
    const encryptedPrivateKey = await encryptPrivateKey(privateKey);

    await db.update(nodes)
      .set({
        publicKey,
        privateKeyEncrypted: encryptedPrivateKey,
        updatedAt: new Date(),
      })
      .where(eq(nodes.id, node.id));

    return { privateKey, publicKey };
  }

  // Decrypt and return existing keys
  const privateKey = await decryptPrivateKey(node.privateKeyEncrypted);
  return { privateKey, publicKey: node.publicKey };
}

/**
 * Decrypt the signing key once per process. All concurrent first callers share
 * one asynchronous scrypt operation, so outbound federation cannot repeatedly
 * block the event loop on synchronous key derivation.
 */
export async function getNodeKeypair(): Promise<{ privateKey: string; publicKey: string }> {
  if (cachedKeypair) return cachedKeypair;
  if (pendingKeypair) return pendingKeypair;

  pendingKeypair = loadNodeKeypair();
  try {
    cachedKeypair = await pendingKeypair;
    return cachedKeypair;
  } finally {
    pendingKeypair = null;
  }
}

/** Explicit invalidation seam for administrative key rotation and tests. */
export function clearNodeKeypairCache(): void {
  cachedKeypair = null;
  pendingKeypair = null;
}

/**
 * Get just the node's public key (for exposing via API)
 */
export async function getNodePublicKey(): Promise<string | null> {
  if (!db) return null;

  if (cachedKeypair) return cachedKeypair.publicKey;

  const domain = process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:43821';
  const node = await db.query.nodes.findFirst({
    where: { domain: domain },
  });

  if (!node?.publicKey) {
    // Generate keys if they don't exist
    const { publicKey } = await getNodeKeypair();
    return publicKey;
  }

  return node.publicKey;
}
