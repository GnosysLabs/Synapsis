/**
 * Identity Cache for TOFU (Trust on First Use) protection
 * 
 * Caches remote user identities to detect key changes.
 * First fetch is trusted (TOFU), subsequent fetches validate against cache.
 */

import { db, remoteIdentityCache } from '@/db';

interface IdentityCacheEntry {
  did: string;
  publicKey: string;
  fetchedAt: Date;
  expiresAt: Date;
}

/**
 * Get cached identity for a DID
 */
export async function getCachedIdentity(did: string): Promise<IdentityCacheEntry | null> {
  const cached = await db.query.remoteIdentityCache.findFirst({
    where: { did: did },
  });
  
  return cached || null;
}

/**
 * Cache a remote user's identity
 */
export async function cacheIdentity(
  did: string,
  _handle: string,
  _nodeDomain: string,
  publicKey: string,
  _displayName: string | null = null,
  _avatarUrl: string | null = null
): Promise<void> {
  void _displayName;
  void _avatarUrl;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 days
  
  await db.insert(remoteIdentityCache)
    .values({
      did,
      publicKey,
      fetchedAt: now,
      expiresAt,
    })
    .onConflictDoUpdate({
      target: remoteIdentityCache.did,
      set: {
        publicKey,
        fetchedAt: now,
        expiresAt,
      },
    });
}

/**
 * Validate key continuity - check if public key matches cached value
 * Returns: { valid: boolean, isFirstUse: boolean, keyChanged?: boolean }
 */
export async function validateKeyContinuity(
  did: string,
  publicKey: string
): Promise<{ valid: boolean; isFirstUse: boolean; keyChanged?: boolean; oldKey?: string }> {
  const cached = await getCachedIdentity(did);
  
  if (!cached) {
    // First time seeing this DID - TOFU moment
    return { valid: true, isFirstUse: true };
  }
  
  if (cached.publicKey === publicKey) {
    // Key matches cached value - all good
    return { valid: true, isFirstUse: false, keyChanged: false };
  }
  
  // Key has changed from cached value
  return { 
    valid: true, // Still accept but warn (configurable)
    isFirstUse: false, 
    keyChanged: true,
    oldKey: cached.publicKey
  };
}

/**
 * Log a security event for key changes
 */
export function logKeyChange(
  did: string,
  handle: string,
  nodeDomain: string,
  oldKey: string,
  newKey: string
): void {
  void oldKey;
  void newKey;
  // Log a prominent security warning
  console.error('╔══════════════════════════════════════════════════════════════════════════════╗');
  console.error('║ 🚨 SECURITY WARNING: REMOTE PUBLIC KEY CHANGED 🚨                            ║');
  console.error('╠══════════════════════════════════════════════════════════════════════════════╣');
  console.error(`║ DID: ${did.padEnd(74)} ║`);
  console.error(`║ Handle: ${handle.padEnd(71)} ║`);
  console.error(`║ Node: ${nodeDomain.padEnd(73)} ║`);
  console.error('║                                                                              ║');
  console.error('║ This could indicate:                                                         ║');
  console.error('║  • MITM attack on your connection to the remote node                         ║');
  console.error('║  • Compromised remote node serving fake keys                                 ║');
  console.error('║  • Legitimate key rotation by the user                                       ║');
  console.error('║                                                                              ║');
  console.error('║ Verify out-of-band if possible.                                              ║');
  console.error('╚══════════════════════════════════════════════════════════════════════════════╝');
}

/**
 * Securely fetch and cache a remote user's public key with TOFU validation
 */
export async function fetchAndCacheRemoteKey(
  did: string,
  handle: string,
  nodeDomain: string,
  fetchPublicKey: () => Promise<string | null>
): Promise<{ publicKey: string | null; fromCache: boolean; keyChanged: boolean }> {
  // Check cache first
  const cached = await getCachedIdentity(did);
  
  if (cached) {
    // We have a cached key - return it but also refresh in background
    // This ensures we detect changes without blocking
    fetchPublicKey().then(async (freshKey) => {
      if (freshKey && freshKey !== cached.publicKey) {
        // Key changed! Log warning
        logKeyChange(did, handle, nodeDomain, cached.publicKey, freshKey);
        
        // Update cache with new key (configurable: could reject instead)
        await cacheIdentity(did, handle, nodeDomain, freshKey, null, null);
      }
    }).catch(err => {
      // Background refresh failed - log but don't fail
      console.error(`[IdentityCache] Background refresh failed for ${did}:`, err);
    });
    
    return { 
      publicKey: cached.publicKey, 
      fromCache: true, 
      keyChanged: false 
    };
  }
  
  // No cached key - fetch it
  const publicKey = await fetchPublicKey();
  
  if (!publicKey) {
    return { publicKey: null, fromCache: false, keyChanged: false };
  }
  
  // Cache the key (TOFU moment)
  await cacheIdentity(did, handle, nodeDomain, publicKey, null, null);
  
  return { 
    publicKey, 
    fromCache: false, 
    keyChanged: false 
  };
}

/**
 * Handle key change policy
 * Returns true if the key change should be accepted
 */
export function shouldAcceptKeyChange(
  did: string,
  handle: string,
  nodeDomain: string,
  oldKey: string,
  newKey: string
): boolean {
  void handle;
  void nodeDomain;
  void oldKey;
  void newKey;
  const policy = process.env.KEY_CHANGE_POLICY || 'warn';
  
  switch (policy) {
    case 'strict':
      // Reject changed keys
      console.error(`[IdentityCache] REJECTING key change for ${did} (strict mode)`);
      return false;
      
    case 'allow':
      // Silently accept
      return true;
      
    case 'warn':
    default:
      // Accept but warn (already logged)
      return true;
  }
}
