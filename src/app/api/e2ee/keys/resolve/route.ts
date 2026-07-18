import { NextRequest, NextResponse } from 'next/server';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { db, e2eeRemoteKeyBundles } from '@/db';
import { getSession } from '@/lib/auth';
import { normalizeSigningPublicKey } from '@/lib/crypto/did-key';
import { withSqliteLockRetry } from '@/lib/db/sqlite-lock-retry';
import { signingPublicKeyFromDid, verifyE2EEPublicBundle } from '@/lib/e2ee/bundle-proof';
import { e2eePublicBundleResponseSchema } from '@/lib/e2ee/protocol';
import {
  FederatedIdentityContinuityError,
  pinVerifiedFederatedActorIdentity,
} from '@/lib/swarm/federated-action';
import { isNodeBlocked, normalizeNodeDomain } from '@/lib/swarm/node-blocklist';
import { getPublicSwarmDomain } from '@/lib/swarm/node-domain';
import { safeFederationRequest } from '@/lib/swarm/safe-federation-http';

const querySchema = z.object({
  did: z.string().min(8).max(2_048).regex(/^did:/),
  handle: z.string().min(1).max(320),
});

class RemoteKeyContinuityError extends Error {
  constructor(
    readonly code: 'E2EE_IDENTITY_KEY_CHANGED' | 'E2EE_KEY_ROLLBACK' | 'E2EE_KEY_CONFLICT',
    message: string,
  ) {
    super(message);
    this.name = 'RemoteKeyContinuityError';
  }
}

export async function GET(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const query = querySchema.parse({
      did: request.nextUrl.searchParams.get('did'),
      handle: request.nextUrl.searchParams.get('handle'),
    });

    const localUser = await db.query.users.findFirst({ where: { did: query.did } });
    const isLocal = localUser && !localUser.handle.includes('@') && !localUser.id.startsWith('swarm:');
    if (isLocal) {
      const requestedHandle = query.handle.toLowerCase().replace(/^@/, '').split('@')[0];
      if (requestedHandle !== localUser.handle.toLowerCase()) {
        return NextResponse.json({ error: 'Recipient identity mismatch' }, { status: 409 });
      }
      const [bundle, vault] = await Promise.all([
        db.query.e2eeKeyBundles.findFirst({ where: { userId: localUser.id } }),
        db.query.e2eeKeyVaults.findFirst({ where: { userId: localUser.id } }),
      ]);
      if (!bundle && !vault) {
        return NextResponse.json({ code: 'E2EE_NOT_CONFIGURED', error: 'Recipient has not set up encrypted messages' }, { status: 404 });
      }
      if (!bundle || !vault || bundle.keyId !== vault.keyId || bundle.keyVersion !== vault.keyVersion
        || bundle.publicKey !== vault.publicKey || vault.ownerDid !== localUser.did) {
        return NextResponse.json({
          code: vault ? 'E2EE_KEY_STATE_INVALID' : 'E2EE_NOT_CONFIGURED',
          error: vault
            ? 'Recipient encryption key state is inconsistent'
            : 'Recipient needs to finish encrypted message setup on this node',
        }, { status: vault ? 500 : 404 });
      }
      const response = e2eePublicBundleResponseSchema.parse({
        bundle: JSON.parse(bundle.proofAction).data,
        proof: JSON.parse(bundle.proofAction),
        signingPublicKey: localUser.publicKey,
      });
      return NextResponse.json(response, { headers: { 'Cache-Control': 'no-store' } });
    }

    const handleParts = query.handle.toLowerCase().replace(/^@/, '').split('@');
    if (handleParts.length !== 2 || !handleParts[0] || !handleParts[1]) {
      return NextResponse.json({ error: 'Remote recipient domain is missing' }, { status: 400 });
    }
    const remoteHandle = handleParts[0];
    const normalizedDomain = normalizeNodeDomain(handleParts.at(-1) || '');
    const isDevelopmentLoopback = process.env.NODE_ENV === 'development'
      && /^localhost(?::\d{1,5})?$/i.test(normalizedDomain);
    const domain = isDevelopmentLoopback
      ? normalizedDomain
      : getPublicSwarmDomain(normalizedDomain);
    if (!domain) {
      return NextResponse.json({ error: 'Recipient node domain is invalid' }, { status: 400 });
    }
    if (await isNodeBlocked(domain)) {
      return NextResponse.json({ error: 'Recipient node is blocked' }, { status: 403 });
    }

    const protocol = isDevelopmentLoopback ? 'http' : 'https';
    const remote = await safeFederationRequest(`${protocol}://${domain}/api/e2ee/keys/${encodeURIComponent(query.did)}`, {
      headers: { Accept: 'application/json' },
      maxResponseBytes: 64 * 1024,
    });
    if (remote.status < 200 || remote.status >= 300) {
      let remoteBody: { code?: string } | null = null;
      try {
        remoteBody = remote.json() as { code?: string };
      } catch {
        // A non-JSON error response still maps to a bounded lookup failure.
      }
      const code = remoteBody?.code === 'E2EE_NOT_CONFIGURED' ? 'E2EE_NOT_CONFIGURED' : 'E2EE_KEY_LOOKUP_FAILED';
      return NextResponse.json({
        error: code === 'E2EE_NOT_CONFIGURED'
          ? 'Recipient has not set up encrypted messages'
          : 'Recipient encryption key could not be verified',
        code,
      }, { status: code === 'E2EE_NOT_CONFIGURED' ? 404 : 502 });
    }

    const response = e2eePublicBundleResponseSchema.parse(remote.json());
    if (response.proof.handle.toLowerCase() !== remoteHandle || !await verifyE2EEPublicBundle(response, query.did)) {
      return NextResponse.json({ error: 'Recipient encryption key proof is invalid' }, { status: 502 });
    }
    const resolvedSigningPublicKey = normalizeSigningPublicKey(response.signingPublicKey);
    if (!resolvedSigningPublicKey) {
      return NextResponse.json({ error: 'Recipient signing key is invalid' }, { status: 502 });
    }
    const canonicalSigningPublicKey = signingPublicKeyFromDid(query.did)
      || resolvedSigningPublicKey;

    const now = new Date();
    const qualifiedHandle = `${remoteHandle}@${domain}`;
    const persistedValues = {
      did: query.did,
      handle: qualifiedHandle,
      keyId: response.bundle.keyId,
      keyVersion: response.bundle.version,
      publicKey: response.bundle.publicKey,
      proofAction: JSON.stringify(response.proof),
      signingPublicKey: canonicalSigningPublicKey,
      updatedAt: now,
    };
    try {
      await withSqliteLockRetry(() => db.transaction(async (tx) => {
        // The user proof has already been verified above. Persist its
        // handle-to-DID authority pin in the same transaction as the key
        // bundle so a crash or concurrent first contact cannot split them.
        await pinVerifiedFederatedActorIdentity({
          sourceDomain: domain,
          actorHandle: remoteHandle,
          did: query.did,
        }, tx);

        const [cached, cachedForHandle] = await Promise.all([
          tx.query.e2eeRemoteKeyBundles.findFirst({ where: { did: query.did } }),
          tx.select({
            did: e2eeRemoteKeyBundles.did,
            handle: e2eeRemoteKeyBundles.handle,
          }).from(e2eeRemoteKeyBundles).where(sql<boolean>`
            lower(ltrim(${e2eeRemoteKeyBundles.handle}, '@')) = ${qualifiedHandle}
          `).limit(2),
        ]);
        if (cachedForHandle.some((candidate) => candidate.did !== query.did)) {
          throw new RemoteKeyContinuityError(
            'E2EE_IDENTITY_KEY_CHANGED',
            'Recipient handle is already bound to another verified identity',
          );
        }
        if (cached && cached.handle.toLowerCase().replace(/^@/, '') !== qualifiedHandle) {
          throw new RemoteKeyContinuityError(
            'E2EE_IDENTITY_KEY_CHANGED',
            'Recipient identity is already bound to another handle',
          );
        }

        const cachedSigningPublicKey = cached
          ? normalizeSigningPublicKey(cached.signingPublicKey)
          : null;
        if (cached && cachedSigningPublicKey !== canonicalSigningPublicKey) {
          throw new RemoteKeyContinuityError(
            'E2EE_IDENTITY_KEY_CHANGED',
            'Recipient signing identity changed unexpectedly',
          );
        }
        if (cached && (
          response.bundle.version < cached.keyVersion
          || (response.bundle.version === cached.keyVersion && response.bundle.keyId !== cached.keyId)
          || (response.bundle.version === cached.keyVersion && response.bundle.publicKey !== cached.publicKey)
          || (response.bundle.version > cached.keyVersion
            && response.bundle.replacesKeyId !== cached.keyId)
        )) {
          throw new RemoteKeyContinuityError(
            'E2EE_KEY_ROLLBACK',
            'Recipient encryption key continuity check failed',
          );
        }

        if (!cached) {
          const [inserted] = await tx.insert(e2eeRemoteKeyBundles)
            .values(persistedValues)
            .onConflictDoNothing()
            .returning({ did: e2eeRemoteKeyBundles.did });
          if (!inserted) {
            throw new RemoteKeyContinuityError(
              'E2EE_KEY_CONFLICT',
              'Recipient encryption key changed during verification; try again',
            );
          }
          return;
        }

        const [updated] = await tx.update(e2eeRemoteKeyBundles).set(persistedValues).where(and(
          eq(e2eeRemoteKeyBundles.did, cached.did),
          eq(e2eeRemoteKeyBundles.handle, cached.handle),
          eq(e2eeRemoteKeyBundles.signingPublicKey, cached.signingPublicKey),
          eq(e2eeRemoteKeyBundles.keyId, cached.keyId),
          eq(e2eeRemoteKeyBundles.keyVersion, cached.keyVersion),
          eq(e2eeRemoteKeyBundles.publicKey, cached.publicKey),
        )).returning({ did: e2eeRemoteKeyBundles.did });
        if (!updated) {
          throw new RemoteKeyContinuityError(
            'E2EE_KEY_CONFLICT',
            'Recipient encryption key changed during verification; try again',
          );
        }
      }));
    } catch (error) {
      if (error instanceof FederatedIdentityContinuityError) {
        return NextResponse.json({
          error: 'Recipient handle is already bound to another verified identity',
          code: 'E2EE_IDENTITY_KEY_CHANGED',
        }, { status: 409 });
      }
      if (error instanceof RemoteKeyContinuityError) {
        return NextResponse.json({ error: error.message, code: error.code }, { status: 409 });
      }
      throw error;
    }

    return NextResponse.json({ ...response, signingPublicKey: canonicalSigningPublicKey }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid key lookup request' }, { status: 400 });
    }
    console.error('[E2EE Keys] Resolution failed:', error);
    return NextResponse.json({ error: 'Recipient encryption key lookup failed', code: 'E2EE_KEY_LOOKUP_FAILED' }, { status: 502 });
  }
}
