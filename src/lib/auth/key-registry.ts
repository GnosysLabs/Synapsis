/**
 * Federation Key Registry
 * 
 * Manages the caching and retrieval of remote public keys.
 * Enforces Key Continuity: Rejects key rotation by default to prevent MITM.
 */

import { db } from '@/db';
import { remoteIdentityCache } from '@/db/schema';
import { eq } from 'drizzle-orm';

// Strict continuity flag: if true (default), reject any key change.
const ALLOW_KEY_ROTATION = process.env.ALLOW_KEY_ROTATION === 'true';

interface RemoteIdentity {
    did: string;
    handle: string;
    publicKey: string;
}

/**
 * Lookup a remote public key by DID.
 * Uses DB cache first, then fetches from .well-known endpoint.
 * Enforces key continuity.
 */
export async function lookupRemoteKey(did: string): Promise<string> {
    // 1. Check Cache
    const cached = await db.query.remoteIdentityCache.findFirst({
        where: { did: did },
    });

    const now = new Date();

    // If valid cache exists, return it
    if (cached && cached.expiresAt > now) {
        return cached.publicKey;
    }

    // 2. Fetch from Remote
    // Resolve DID to HTTP URL (Assuming Web DID or simple mapping for now)
    // For did:web:example.com -> https://example.com/.well-known/synapsis/identity/{did}
    // This logic depends on our DID method. 
    // IMPORTANT: For this strict implementation, we need a reliable way to map DID -> Endpoint.
    // We'll assume the DID *contains* the domain or we have a resolver.
    // Simplification: `did:web:domain` format.

    const domain = extractDomainFromDid(did);
    if (!domain) {
        throw new Error(`Unsupported DID format: ${did}`);
    }

    let remoteData: RemoteIdentity;
    try {
        const res = await fetch(`https://${domain}/.well-known/synapsis/identity/${did}`);
        if (!res.ok) throw new Error(`Remote identity fetch failed: ${res.status}`);
        remoteData = await res.json();
    } catch (err) {
        // If we have an expired cache entry, we *could* fallback to it in emergency, 
        // but strict security says fail.
        console.error(`[KeyRegistry] Failed to fetch key for ${did}`, err);
        throw new Error('RELAY_UNREACHABLE');
    }

    // Optimize: Validation
    if (remoteData.did !== did || !remoteData.publicKey) {
        throw new Error('Invalid remote identity response');
    }

    // 3. Key Continuity Check
    if (cached) {
        if (cached.publicKey !== remoteData.publicKey) {
            if (!ALLOW_KEY_ROTATION) {
                console.error(`[KeyRegistry] KEY_CHANGED detected for ${did}. Old: ${cached.publicKey.slice(0, 10)}... New: ${remoteData.publicKey.slice(0, 10)}...`);
                throw new Error('KEY_CHANGED: Remote key rotation rejected by policy.');
            }
            // If allowed, we proceed (TOFU update)
        }
    }

    // 4. Update Cache
    const expiresAt = new Date(now.getTime() + 60 * 60 * 1000); // 1 hour TTL

    await db.insert(remoteIdentityCache).values({
        did,
        publicKey: remoteData.publicKey,
        fetchedAt: now,
        expiresAt,
    }).onConflictDoUpdate({
        target: remoteIdentityCache.did,
        set: {
            publicKey: remoteData.publicKey,
            fetchedAt: now,
            expiresAt,
        },
    });

    return remoteData.publicKey;
}

function extractDomainFromDid(did: string): string | null {
    // did:web:example.com
    // did:synapsis:example.com
    const parts = did.split(':');
    if (parts.length >= 3) {
        return parts[2];
    }
    return null;
}
