import { NextRequest, NextResponse } from 'next/server';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';

import { db, e2eeKeyVaults } from '@/db';
import { getSession } from '@/lib/auth';
import {
  E2EE_LOCKOUT_MS,
  E2EE_MAX_UNLOCK_ATTEMPTS,
  E2EE_PROTOCOL,
} from '@/lib/e2ee/protocol';
import { openServerShare, pinVerifierMatches } from '@/lib/e2ee/server-secrets';

const unlockSchema = z.strictObject({
  ownerDid: z.string().min(8).max(2_048).regex(/^did:/),
  keyId: z.string().min(12).max(96).regex(/^k1_[A-Za-z0-9_-]+$/),
  keyVersion: z.number().int().positive().max(1_000_000),
  pinVerifier: z.string().min(40).max(64).regex(/^[A-Za-z0-9_-]+$/),
});

const MAX_CAS_RETRIES = 16;

export async function POST(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const { ownerDid, keyId, keyVersion, pinVerifier } = unlockSchema.parse(await request.json());

    let observedKey: { keyId: string; keyVersion: number } | null = null;

    for (let retry = 0; retry < MAX_CAS_RETRIES; retry += 1) {
      const vault = await db.query.e2eeKeyVaults.findFirst({ where: { userId: session.user.id } });
      if (!vault) return NextResponse.json({ error: 'Encrypted messages are not configured' }, { status: 404 });

      if (ownerDid !== session.user.did || vault.ownerDid !== ownerDid
        || vault.keyId !== keyId || vault.keyVersion !== keyVersion) {
        return NextResponse.json({
          error: 'The active account or encryption key changed during unlock',
          code: 'E2EE_ACCOUNT_CHANGED',
        }, { status: 409 });
      }

      if (observedKey && (vault.keyId !== observedKey.keyId || vault.keyVersion !== observedKey.keyVersion)) {
        return NextResponse.json({
          error: 'Encryption key changed during unlock',
          code: 'E2EE_KEY_CONFLICT',
        }, { status: 409 });
      }
      observedKey ??= { keyId: vault.keyId, keyVersion: vault.keyVersion };

      const now = new Date();
      if (vault.lockedUntil && vault.lockedUntil > now) {
        return NextResponse.json({
          error: 'Too many recovery attempts',
          code: 'E2EE_RECOVERY_LOCKED',
          lockedUntil: vault.lockedUntil.toISOString(),
        }, { status: 429 });
      }

      const unchangedVault = and(
        eq(e2eeKeyVaults.userId, session.user.id),
        eq(e2eeKeyVaults.keyId, vault.keyId),
        eq(e2eeKeyVaults.keyVersion, vault.keyVersion),
        eq(e2eeKeyVaults.pinVerifierMac, vault.pinVerifierMac),
        eq(e2eeKeyVaults.failedAttempts, vault.failedAttempts),
        vault.lockedUntil
          ? eq(e2eeKeyVaults.lockedUntil, vault.lockedUntil)
          : isNull(e2eeKeyVaults.lockedUntil),
      );

      if (!pinVerifierMatches(pinVerifier, vault.pinVerifierMac, session.user.id, vault.keyId)) {
        const priorAttempts = vault.lockedUntil && vault.lockedUntil <= now ? 0 : vault.failedAttempts;
        const failedAttempts = priorAttempts + 1;
        const shouldLock = failedAttempts >= E2EE_MAX_UNLOCK_ATTEMPTS;
        const lockedUntil = shouldLock ? new Date(Date.now() + E2EE_LOCKOUT_MS) : null;
        const [updated] = await db.update(e2eeKeyVaults).set({
          failedAttempts: shouldLock ? 0 : failedAttempts,
          lockedUntil,
          updatedAt: now,
        }).where(unchangedVault).returning({ userId: e2eeKeyVaults.userId });

        if (!updated) continue;

        return NextResponse.json({
          error: shouldLock
            ? 'Too many recovery attempts'
            : vault.recoveryMethod === 'password' ? 'Incorrect password' : 'Incorrect previous PIN',
          code: shouldLock ? 'E2EE_RECOVERY_LOCKED' : 'E2EE_RECOVERY_INCORRECT',
          attemptsRemaining: shouldLock ? 0 : E2EE_MAX_UNLOCK_ATTEMPTS - failedAttempts,
          lockedUntil: lockedUntil?.toISOString() ?? null,
        }, { status: shouldLock ? 429 : 403 });
      }

      const [updated] = await db.update(e2eeKeyVaults).set({
        failedAttempts: 0,
        lockedUntil: null,
        updatedAt: now,
      }).where(unchangedVault).returning({ userId: e2eeKeyVaults.userId });

      if (!updated) continue;

      return NextResponse.json({
        serverShare: openServerShare(vault.serverShareEncrypted, session.user.id, vault.keyId),
        vault: {
          protocol: E2EE_PROTOCOL,
          ownerDid: session.user.did,
          keyId: vault.keyId,
          keyVersion: vault.keyVersion,
          publicKey: vault.publicKey,
          ciphertext: vault.ciphertext,
          nonce: vault.nonce,
          salt: vault.salt,
          kdfAlgorithm: vault.kdfAlgorithm,
          kdfOpsLimit: vault.kdfOpsLimit,
          kdfMemLimit: vault.kdfMemLimit,
        },
      }, { headers: { 'Cache-Control': 'no-store' } });
    }

    return NextResponse.json({
      error: 'Encrypted message unlock was busy; retry',
      code: 'E2EE_UNLOCK_CONFLICT',
    }, { status: 409 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid unlock request' }, { status: 400 });
    }
    console.error('[E2EE Vault] Unlock failed:', error);
    return NextResponse.json({ error: 'Failed to unlock encrypted messages' }, { status: 500 });
  }
}
