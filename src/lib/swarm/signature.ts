/**
 * Swarm Signature Verification
 * 
 * Cryptographic signatures for all swarm interactions to prevent forgery.
 * Each node signs requests with their private key, and recipients verify
 * using the sender's public key.
 */

import crypto from 'crypto';
import { db, users } from '@/db';
import { eq } from 'drizzle-orm';
import { canonicalize } from '@/lib/crypto/user-signing';

/**
 * Sign a payload with the node's private key
 */
export function signPayload(payload: any, privateKey: string): string {
  const canonicalPayload = canonicalize(payload);
  const sign = crypto.createSign('SHA256');
  sign.update(canonicalPayload);
  sign.end();
  return sign.sign(privateKey, 'base64');
}

function normalizePublicKey(publicKey: string): crypto.KeyObject | string {
  if (publicKey.includes('BEGIN PUBLIC KEY')) {
    return publicKey;
  }

  const cleanKey = publicKey.replace(/[\s\n\r]/g, '');
  return crypto.createPublicKey({
    key: Buffer.from(cleanKey, 'base64'),
    format: 'der',
    type: 'spki',
  });
}

/**
 * Verify a signature using the sender's public key
 */
export function verifySignature(payload: any, signature: string, publicKey: string): boolean {
  try {
    const canonicalPayload = canonicalize(payload);
    const verify = crypto.createVerify('SHA256');
    verify.update(canonicalPayload);
    verify.end();
    return verify.verify(normalizePublicKey(publicKey), signature, 'base64');
  } catch (error) {
    console.error('[Signature] Verification failed:', error);
    return false;
  }
}

/**
 * Fetch and cache a node's public key
 */
export async function getNodePublicKey(domain: string): Promise<string | null> {
  try {
    // Check if we have a cached node info
    const protocol = domain.includes('localhost') ? 'http' : 'https';
    const response = await fetch(`${protocol}://${domain}/api/node`, {
      headers: { 'Accept': 'application/json' },
    });

    if (!response.ok) {
      console.error(`[Signature] Failed to fetch node info from ${domain}: ${response.status}`);
      return null;
    }

    const data = await response.json();
    return data.publicKey || null;
  } catch (error) {
    console.error(`[Signature] Error fetching public key from ${domain}:`, error);
    return null;
  }
}

/**
 * Verify a swarm request signature
 * 
 * @param payload - The request payload (without signature field)
 * @param signature - The signature to verify
 * @param senderDomain - The domain of the sender node
 * @returns true if signature is valid, false otherwise
 */
export async function verifySwarmRequest(
  payload: any,
  signature: string,
  senderDomain: string
): Promise<boolean> {
  // Get the sender node's public key
  const publicKey = await getNodePublicKey(senderDomain);
  
  if (!publicKey) {
    console.error(`[Signature] Could not get public key for ${senderDomain}`);
    return false;
  }

  // Verify the signature
  return verifySignature(payload, signature, publicKey);
}

/**
 * Verify a user interaction signature
 * 
 * For user-specific interactions (like, follow, etc), we verify using
 * the user's public key, not the node's.
 * 
 * @param payload - The request payload (without signature field)
 * @param signature - The signature to verify
 * @param userHandle - The full handle of the user (handle@domain)
 * @returns true if signature is valid, false otherwise
 */
export async function verifyUserInteraction(
  payload: any,
  signature: string,
  userHandle: string,
  userDomain: string
): Promise<boolean> {
  try {
    // Try to get cached user
    const fullHandle = `${userHandle}@${userDomain}`;
    let user = await db?.query.users.findFirst({
      where: eq(users.handle, fullHandle),
    });

    let publicKey: string | null = null;

    if (user?.publicKey) {
      publicKey = user.publicKey;
    } else {
      // Fetch from remote node
      const protocol = userDomain.includes('localhost') ? 'http' : 'https';
      const response = await fetch(`${protocol}://${userDomain}/api/users/${userHandle}`);
      
      if (!response.ok) {
        console.error(`[Signature] Failed to fetch user ${userHandle}@${userDomain}: ${response.status}`);
        return false;
      }

      const userData = await response.json();
      publicKey = userData.user?.publicKey || userData.publicKey;

      // Cache the user if we don't have them
      if (!user && publicKey && db) {
        await db.insert(users).values({
          did: userData.user?.did || `did:swarm:${userDomain}:${userHandle}`,
          handle: fullHandle,
          displayName: userData.user?.displayName || userHandle,
          avatarUrl: userData.user?.avatarUrl,
          publicKey,
        }).onConflictDoNothing();
      } else if (user && publicKey && db) {
        // Update cached user's public key
        await db.update(users)
          .set({ publicKey })
          .where(eq(users.id, user.id));
      }
    }

    if (!publicKey) {
      console.error(`[Signature] No public key found for ${fullHandle}`);
      return false;
    }

    // Verify the signature
    return verifySignature(payload, signature, publicKey);
  } catch (error) {
    console.error(`[Signature] Error verifying user interaction:`, error);
    return false;
  }
}

/**
 * Get the node's private key
 */
export async function getNodePrivateKey(): Promise<string> {
  const { getNodeKeypair } = await import('./node-keys');
  const { privateKey } = await getNodeKeypair();
  return privateKey;
}

/**
 * Create a signed payload for sending to another node
 */
export async function createSignedPayload(payload: any): Promise<{ payload: any; signature: string }> {
  const privateKey = await getNodePrivateKey();
  const signature = signPayload(payload, privateKey);
  return { payload, signature };
}
