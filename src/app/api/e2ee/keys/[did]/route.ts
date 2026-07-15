import { NextResponse } from 'next/server';

import { db } from '@/db';
import { e2eeKeyBundleSchema, signedUserActionSchema } from '@/lib/e2ee/protocol';

type RouteContext = { params: Promise<{ did: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const { did } = await context.params;
  const user = await db.query.users.findFirst({ where: { did } });
  if (!user || user.handle.includes('@') || user.id.startsWith('swarm:')) {
    return NextResponse.json({ error: 'Encryption key not found' }, { status: 404 });
  }

  const [row, vault] = await Promise.all([
    db.query.e2eeKeyBundles.findFirst({ where: { userId: user.id } }),
    db.query.e2eeKeyVaults.findFirst({ where: { userId: user.id } }),
  ]);
  if (!row && !vault) {
    return NextResponse.json({
      error: 'Encrypted messages are not configured for this account',
      code: 'E2EE_NOT_CONFIGURED',
    }, { status: 404 });
  }
  if (!row || !vault || row.keyId !== vault.keyId || row.keyVersion !== vault.keyVersion
    || row.publicKey !== vault.publicKey || vault.ownerDid !== user.did) {
    return NextResponse.json({
      error: vault ? 'Encrypted message key state is inconsistent' : 'Encrypted messages need setup on this node',
      code: vault ? 'E2EE_KEY_STATE_INVALID' : 'E2EE_NOT_CONFIGURED',
    }, { status: vault ? 500 : 404 });
  }

  try {
    const proof = signedUserActionSchema.parse(JSON.parse(row.proofAction));
    const bundle = e2eeKeyBundleSchema.parse(proof.data);
    return NextResponse.json({
      bundle,
      proof,
      signingPublicKey: user.publicKey,
    }, { headers: { 'Cache-Control': 'public, max-age=60, must-revalidate' } });
  } catch (error) {
    console.error('[E2EE Keys] Stored key proof is invalid:', error);
    return NextResponse.json({ error: 'Encryption key proof is invalid' }, { status: 500 });
  }
}
