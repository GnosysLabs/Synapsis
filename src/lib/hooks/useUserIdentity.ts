/**
 * User Identity Hook
 * 
 * Manages the user's cryptographic identity with persistent storage.
 * Keys are encrypted at rest in IndexedDB and automatically restored
 * across page refreshes and tabs.
 */

import { useState, useEffect, useCallback } from 'react';
import { decryptPrivateKey } from '@/lib/crypto/private-key-client';
import {
  persistUnlockedKey,
  tryRestoreKey,
  clearPersistentKey,
  hasPersistentKey,
} from '@/lib/crypto/key-persistence';
import {
  keyStore,
  importPrivateKey,
  generateKeyPair,
  exportPrivateKey,
  exportPublicKey,
  base64UrlToBase64,
  createSignedAction
} from '@/lib/crypto/user-signing';

export interface UserIdentity {
  did: string;
  handle: string;
  publicKey: string;
  isUnlocked: boolean;
}

export function useUserIdentity() {
  const [identity, setIdentity] = useState<UserIdentity | null>(null);
  const [isUnlocked, setIsUnlocked] = useState(false);
  const [isRestoring, setIsRestoring] = useState(true);

  // Check status on mount and try to restore from persistence
  useEffect(() => {
    const checkAndRestore = async () => {
      setIsRestoring(true);
      try {
        // First check if already in memory (hot reload scenario)
        const hasKey = !!keyStore.getPrivateKey();
        const globalIdentity = keyStore.getIdentity();
        
        if (hasKey && globalIdentity) {
          setIdentity({ ...globalIdentity, isUnlocked: true });
          setIsUnlocked(true);
          setIsRestoring(false);
          return;
        }

        if (!globalIdentity?.did) {
          return;
        }

        // Try to restore from persistent storage
        const restoredKeyBytes = await tryRestoreKey(globalIdentity.did);
        if (restoredKeyBytes) {
          // Import the restored key as non-extractable
          const cryptoKey = await importPrivateKey(restoredKeyBytes);
          keyStore.setPrivateKey(cryptoKey);
          setIdentity({ ...globalIdentity, isUnlocked: true });
          setIsUnlocked(true);
          console.log('[Identity] Auto-restored from persistent storage');
        } else if (globalIdentity) {
          // Have identity info but no key - locked state
          setIdentity({ ...globalIdentity, isUnlocked: false });
          setIsUnlocked(false);
        }
      } catch (error) {
        console.error('[Identity] Error during restore:', error);
      } finally {
        setIsRestoring(false);
      }
    };

    checkAndRestore();
  }, []);

  /**
   * Initialize identity from user data
   * Call this when user data is loaded from the server
   */
  const initializeIdentity = useCallback(async (userData: {
    did: string;
    handle: string;
    publicKey: string;
    privateKeyEncrypted?: string;
  }) => {
    keyStore.clear();

    const coreIdentity = {
      did: userData.did,
      handle: userData.handle,
      publicKey: userData.publicKey
    };
    keyStore.setIdentity(coreIdentity);
    
    // Try to auto-restore if we have persisted key
    const restoredKeyBytes = await tryRestoreKey(userData.did);
    if (restoredKeyBytes) {
      const cryptoKey = await importPrivateKey(restoredKeyBytes);
      keyStore.setPrivateKey(cryptoKey);
      setIdentity({ ...coreIdentity, isUnlocked: true });
      setIsUnlocked(true);
    } else {
      setIdentity({ ...coreIdentity, isUnlocked: false });
      setIsUnlocked(false);
    }
  }, []);

  /**
   * Unlock the identity with a password
   * Also persists the key for auto-unlock on refresh
   */
  const unlockIdentity = useCallback(async (
    privateKeyEncrypted: string, 
    password: string, 
    userDid?: string, 
    userHandle?: string, 
    userPublicKey?: string
  ) => {
    try {
      console.log('[Identity] Unlocking with DID:', userDid, 'Handle:', userHandle);

      // Set identity first if provided
      if (userDid && userHandle && userPublicKey) {
        keyStore.setIdentity({
          did: userDid,
          handle: userHandle,
          publicKey: userPublicKey
        });
      }

      // Decrypt the private key
      const privateKeyPemOrBase64 = await decryptPrivateKey(privateKeyEncrypted, password);

      // Clean up if it's PEM to get Base64
      let privateKeyBase64 = privateKeyPemOrBase64;
      if (privateKeyBase64.includes('-----BEGIN')) {
        privateKeyBase64 = privateKeyBase64
          .replace(/-----BEGIN [A-Z ]+-----/, '')
          .replace(/-----END [A-Z ]+-----/, '')
          .replace(/\s/g, '');
      }

      // Import into CryptoKey (non-extractable for security)
      const binaryDer = Buffer.from(privateKeyBase64, 'base64');
      const cryptoKey = await importPrivateKey(binaryDer);

      // Store in memory
      keyStore.setPrivateKey(cryptoKey);
      
      // PERSIST: Save raw key bytes for auto-restore on refresh
      // We pass the raw bytes because the CryptoKey is non-extractable
      if (!userDid) {
        throw new Error('User DID is required to persist the unlocked identity');
      }

      await persistUnlockedKey(privateKeyBase64, password, userDid);
      
      console.log('[Identity] Private key stored in memory and persisted');

      // Update State
      const globalIdentity = keyStore.getIdentity();
      if (globalIdentity) {
        setIdentity({ ...globalIdentity, isUnlocked: true });
      }
      setIsUnlocked(true);

    } catch (error) {
      console.error('[Identity] Failed to unlock identity:', error);
      throw new Error('Failed to unlock identity. Incorrect password?');
    }
  }, []);

  /**
   * Lock the identity (manual lock, keeps identity info)
   */
  const lockIdentity = useCallback(async () => {
    const identifier = keyStore.getIdentity()?.did;
    keyStore.clear();
    await clearPersistentKey(identifier);
    setIsUnlocked(false);
    setIdentity(prev => prev ? { ...prev, isUnlocked: false } : null);
  }, []);

  /**
   * Clear the identity (logout)
   */
  const clearIdentity = useCallback(async () => {
    const identifier = keyStore.getIdentity()?.did;
    keyStore.clear();
    await clearPersistentKey(identifier);
    setIdentity(null);
    setIsUnlocked(false);
  }, []);

  /**
   * Sign a user action
   */
  const signUserAction = useCallback(async (action: string, data: any) => {
    const pk = keyStore.getPrivateKey();
    const id = keyStore.getIdentity();

    if (!id || !pk) {
      console.error('[Identity] Sign failed. Identity:', id, 'HasKey:', !!pk);
      throw new Error('Identity locked');
    }
    
    return await createSignedAction(action, data, id.did, id.handle);
  }, []);

  return {
    identity,
    isUnlocked,
    isRestoring,  // New: lets UI know if we're checking persistence
    initializeIdentity,
    unlockIdentity,
    lockIdentity,
    clearIdentity,
    signUserAction
  };
}
