import crypto from 'node:crypto';

import { NextRequest, NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import { db, e2eeKeyBundles, e2eeKeyVaults } from '@/db';
import { requireSignedAction, SignedActionError, type SignedAction } from '@/lib/auth/verify-signature';
import {
  E2EE_KEY_BUNDLE_ACTION,
  E2EE_MAX_UNLOCK_ATTEMPTS,
  E2EE_VAULT_REWRAP_ACTION,
  e2eeKeyBundleSchema,
  e2eeVaultSetupSchema,
  signedUserActionSchema,
} from '@/lib/e2ee/protocol';
import { createPinVerifierMac, sealServerShare } from '@/lib/e2ee/server-secrets';
import { getSession, verifyPassword } from '@/lib/auth';
import { canonicalize } from '@/lib/crypto/user-signing';

const setupRequestSchema = z.strictObject({
  proof: signedUserActionSchema,
  recovery: e2eeVaultSetupSchema,
  currentPassword: z.string().min(8).max(256).optional(),
});

const rewrapProofDataSchema = z.strictObject({
  keyId: z.string().min(12).max(96),
  keyVersion: z.number().int().positive(),
  recoveryCommitment: z.string().min(40).max(64),
});

const rewrapRequestSchema = z.strictObject({
  proof: signedUserActionSchema,
  recovery: e2eeVaultSetupSchema,
  currentPassword: z.string().min(8).max(256),
});

class E2EEKeyConflictError extends Error {}

function byteLength(value: string): number {
  return Buffer.from(value, 'base64url').length;
}

function validateEncodedLengths(recovery: z.infer<typeof e2eeVaultSetupSchema>): void {
  if (byteLength(recovery.vault.publicKey) !== 32) throw new Error('Invalid encryption public key');
  if (byteLength(recovery.serverShare) !== 32) throw new Error('Invalid recovery share');
  if (byteLength(recovery.pinVerifier) !== 32) throw new Error('Invalid recovery verifier');
  if (byteLength(recovery.vault.salt) !== 16) throw new Error('Invalid recovery salt');
  if (byteLength(recovery.vault.nonce) !== 24) throw new Error('Invalid vault nonce');
  const ciphertextLength = byteLength(recovery.vault.ciphertext);
  if (ciphertextLength < 64 || ciphertextLength > 3_072) throw new Error('Invalid encrypted vault');
}

export async function GET() {
  const session = await getSession();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const [bundle, vault] = await Promise.all([
    db.query.e2eeKeyBundles.findFirst({ where: { userId: session.user.id } }),
    db.query.e2eeKeyVaults.findFirst({ where: { userId: session.user.id } }),
  ]);

  if (!bundle && !vault) {
    return NextResponse.json(
      { ownerDid: session.user.did, configured: false },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }
  if (bundle && !vault && bundle.did === session.user.did) {
    return NextResponse.json({
      ownerDid: session.user.did,
      configured: false,
      previousKey: {
        keyId: bundle.keyId,
        keyVersion: bundle.keyVersion,
      },
    }, { headers: { 'Cache-Control': 'no-store' } });
  }
  if (!bundle || !vault
    || bundle.did !== session.user.did
    || vault.ownerDid !== session.user.did
    || bundle.keyId !== vault.keyId
    || bundle.keyVersion !== vault.keyVersion
    || bundle.publicKey !== vault.publicKey) {
    return NextResponse.json({ error: 'Encrypted message recovery is inconsistent' }, { status: 500 });
  }

  return NextResponse.json({
    ownerDid: session.user.did,
    configured: true,
    keyId: bundle.keyId,
    keyVersion: bundle.keyVersion,
    publicKey: bundle.publicKey,
    salt: vault.salt,
    kdfAlgorithm: vault.kdfAlgorithm,
    kdfOpsLimit: vault.kdfOpsLimit,
    kdfMemLimit: vault.kdfMemLimit,
    recoveryMethod: vault.recoveryMethod === 'password' ? 'password' : 'legacy_pin',
    failedAttempts: vault.failedAttempts,
    attemptsRemaining: vault.lockedUntil && vault.lockedUntil > new Date()
      ? 0
      : Math.max(0, E2EE_MAX_UNLOCK_ATTEMPTS - vault.failedAttempts),
    lockedUntil: vault.lockedUntil?.toISOString() ?? null,
  }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = setupRequestSchema.parse(await request.json());
    const proof = body.proof;
    if (proof.action !== E2EE_KEY_BUNDLE_ACTION) {
      return NextResponse.json({ error: 'Invalid encryption key proof' }, { status: 400 });
    }
    if (proof.did !== session.user.did || proof.handle !== session.user.handle) {
      return NextResponse.json({ error: 'Active account does not match encryption setup' }, { status: 403 });
    }

    const user = await requireSignedAction(proof as SignedAction);
    if (user.id !== session.user.id) {
      return NextResponse.json({ error: 'Active account does not match encryption setup' }, { status: 403 });
    }
    const bundle = e2eeKeyBundleSchema.parse(proof.data);
    if (byteLength(bundle.recoveryCommitment) !== 32) {
      return NextResponse.json({ error: 'Invalid recovery commitment' }, { status: 400 });
    }
    const recovery = body.recovery;
    validateEncodedLengths(recovery);

    const recoveryCommitment = crypto.createHash('sha256')
      .update(canonicalize(recovery))
      .digest('base64url');
    if (bundle.recoveryCommitment !== recoveryCommitment) {
      return NextResponse.json({ error: 'Recovery vault does not match the signed key proof' }, { status: 400 });
    }

    if (recovery.vault.ownerDid !== proof.did
      || recovery.vault.keyId !== bundle.keyId
      || recovery.vault.keyVersion !== bundle.version
      || recovery.vault.publicKey !== bundle.publicKey) {
      return NextResponse.json({ error: 'Recovery vault does not match the signed key' }, { status: 400 });
    }
    if (Math.abs(bundle.createdAt - proof.ts) > 5 * 60 * 1000) {
      return NextResponse.json({ error: 'Encryption key timestamp is invalid' }, { status: 400 });
    }

    const [existing, existingVault] = await Promise.all([
      db.query.e2eeKeyBundles.findFirst({ where: { userId: user.id } }),
      db.query.e2eeKeyVaults.findFirst({ where: { userId: user.id } }),
    ]);
    if (existing && existing.did !== user.did) {
      return NextResponse.json({ error: 'Encryption key identity is inconsistent' }, { status: 409 });
    }
    if (!existing && bundle.replacesKeyId) {
      return NextResponse.json({ error: 'There is no encryption key to replace' }, { status: 409 });
    }
    if (existing && bundle.replacesKeyId !== existing.keyId) {
      return NextResponse.json({
        error: 'Encrypted messages are already configured',
        code: 'E2EE_ALREADY_CONFIGURED',
      }, { status: 409 });
    }
    if ((!existing && bundle.version !== 1)
      || (existing && bundle.version !== existing.keyVersion + 1)) {
      return NextResponse.json({ error: 'Encryption key version is invalid' }, { status: 409 });
    }
    if (!body.currentPassword || !user.passwordHash
      || !await verifyPassword(body.currentPassword, user.passwordHash)) {
      return NextResponse.json({ error: 'Current password is required for encrypted messages' }, { status: 403 });
    }

    const now = new Date();
    const verifierMac = createPinVerifierMac(recovery.pinVerifier, user.id, bundle.keyId);
    const sealedShare = sealServerShare(recovery.serverShare, user.id, bundle.keyId);
    const vaultValues = {
      keyId: bundle.keyId,
      keyVersion: bundle.version,
      ownerDid: proof.did,
      publicKey: bundle.publicKey,
      ciphertext: recovery.vault.ciphertext,
      nonce: recovery.vault.nonce,
      salt: recovery.vault.salt,
      kdfAlgorithm: recovery.vault.kdfAlgorithm,
      kdfOpsLimit: recovery.vault.kdfOpsLimit,
      kdfMemLimit: recovery.vault.kdfMemLimit,
      recoveryMethod: 'password',
      pinVerifierMac: verifierMac,
      serverShareEncrypted: sealedShare,
      failedAttempts: 0,
      lockedUntil: null,
      updatedAt: now,
    };

    await db.transaction(async (tx) => {
      if (existing) {
        const [updatedBundle] = await tx.update(e2eeKeyBundles).set({
          did: user.did,
          keyId: bundle.keyId,
          keyVersion: bundle.version,
          publicKey: bundle.publicKey,
          proofAction: JSON.stringify(proof),
          updatedAt: now,
        }).where(and(
          eq(e2eeKeyBundles.userId, user.id),
          eq(e2eeKeyBundles.keyId, existing.keyId),
          eq(e2eeKeyBundles.keyVersion, existing.keyVersion),
        )).returning({ userId: e2eeKeyBundles.userId });
        if (!updatedBundle) throw new E2EEKeyConflictError('Encryption key changed during reset');

        if (existingVault) {
          const [updatedVault] = await tx.update(e2eeKeyVaults).set(vaultValues).where(and(
            eq(e2eeKeyVaults.userId, user.id),
            eq(e2eeKeyVaults.keyId, existing.keyId),
            eq(e2eeKeyVaults.keyVersion, existing.keyVersion),
          )).returning({ userId: e2eeKeyVaults.userId });
          if (!updatedVault) throw new E2EEKeyConflictError('Recovery vault changed during reset');
        } else {
          await tx.insert(e2eeKeyVaults).values({ userId: user.id, ...vaultValues });
        }
        return;
      }

      await tx.insert(e2eeKeyBundles).values({
        userId: user.id,
        did: user.did,
        keyId: bundle.keyId,
        keyVersion: bundle.version,
        publicKey: bundle.publicKey,
        proofAction: JSON.stringify(proof),
        updatedAt: now,
      });
      await tx.insert(e2eeKeyVaults).values({ userId: user.id, ...vaultValues });
    });

    return NextResponse.json({ success: true, keyId: bundle.keyId });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid encrypted message setup', details: error.issues }, { status: 400 });
    }
    if (error instanceof SignedActionError) {
      return NextResponse.json({
        error: error.message === 'RATE_LIMITED'
          ? 'Too many encryption setup attempts; try again shortly'
          : 'Encryption key proof was rejected',
        code: error.message === 'RATE_LIMITED' ? 'E2EE_RATE_LIMITED' : 'E2EE_SIGNATURE_REJECTED',
      }, { status: error.message === 'RATE_LIMITED' ? 429 : 403 });
    }
    if (error instanceof E2EEKeyConflictError
      || (error instanceof Error && /unique|constraint/i.test(error.message))) {
      return NextResponse.json({
        error: 'Encrypted messages changed in another tab. Reload Chat and try again.',
        code: 'E2EE_KEY_CONFLICT',
      }, { status: 409 });
    }
    console.error('[E2EE Vault] Setup failed:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Setup failed' }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const body = rewrapRequestSchema.parse(await request.json());
    if (body.proof.action !== E2EE_VAULT_REWRAP_ACTION
      || body.proof.did !== session.user.did
      || body.proof.handle !== session.user.handle) {
      return NextResponse.json({ error: 'Invalid recovery update proof' }, { status: 403 });
    }
    const user = await requireSignedAction(body.proof as SignedAction);
    if (user.id !== session.user.id || !user.passwordHash
      || !await verifyPassword(body.currentPassword, user.passwordHash)) {
      return NextResponse.json({ error: 'Incorrect current password' }, { status: 403 });
    }
    const proofData = rewrapProofDataSchema.parse(body.proof.data);
    const vault = await db.query.e2eeKeyVaults.findFirst({ where: { userId: user.id } });
    if (!vault) return NextResponse.json({ error: 'Encrypted messages are not configured' }, { status: 404 });
    const recovery = body.recovery;
    validateEncodedLengths(recovery);
    const commitment = crypto.createHash('sha256').update(canonicalize(recovery)).digest('base64url');
    if (proofData.recoveryCommitment !== commitment
      || proofData.keyId !== vault.keyId
      || proofData.keyVersion !== vault.keyVersion
      || recovery.vault.ownerDid !== user.did
      || recovery.vault.keyId !== vault.keyId
      || recovery.vault.keyVersion !== vault.keyVersion
      || recovery.vault.publicKey !== vault.publicKey) {
      return NextResponse.json({ error: 'Recovery update does not match the active encryption key' }, { status: 409 });
    }
    const [updated] = await db.update(e2eeKeyVaults).set({
      ciphertext: recovery.vault.ciphertext,
      nonce: recovery.vault.nonce,
      salt: recovery.vault.salt,
      kdfAlgorithm: recovery.vault.kdfAlgorithm,
      kdfOpsLimit: recovery.vault.kdfOpsLimit,
      kdfMemLimit: recovery.vault.kdfMemLimit,
      recoveryMethod: 'password',
      pinVerifierMac: createPinVerifierMac(recovery.pinVerifier, user.id, vault.keyId),
      serverShareEncrypted: sealServerShare(recovery.serverShare, user.id, vault.keyId),
      failedAttempts: 0,
      lockedUntil: null,
      updatedAt: new Date(),
    }).where(and(
      eq(e2eeKeyVaults.userId, user.id),
      eq(e2eeKeyVaults.keyId, vault.keyId),
      eq(e2eeKeyVaults.keyVersion, vault.keyVersion),
    )).returning({ userId: e2eeKeyVaults.userId });
    if (!updated) {
      return NextResponse.json({ error: 'Encryption key changed during recovery update' }, { status: 409 });
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid recovery update' }, { status: 400 });
    }
    if (error instanceof SignedActionError) {
      return NextResponse.json({ error: 'Recovery update proof was rejected' }, { status: 403 });
    }
    console.error('[E2EE Vault] Recovery update failed:', error);
    return NextResponse.json({ error: 'Encrypted message recovery could not be updated' }, { status: 500 });
  }
}
