import crypto from 'node:crypto';

import { safeFederationRequest } from '@/lib/swarm/safe-federation-http';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface SignedAccountMoveNotice {
  oldHandle: string;
  newActorUrl: string;
  did: string;
  movedAt: string;
  signature: string;
}

export function createSignedAccountMoveNotice(input: {
  oldHandle: string;
  newActorUrl: string;
  did: string;
  privateKey: string;
  movedAt?: Date;
}): SignedAccountMoveNotice {
  const payload = {
    oldHandle: input.oldHandle,
    newActorUrl: input.newActorUrl,
    did: input.did,
    movedAt: (input.movedAt ?? new Date()).toISOString(),
  };
  const sign = crypto.createSign('sha256');
  sign.update(JSON.stringify(payload));
  return {
    ...payload,
    signature: sign.sign(input.privateKey, 'base64'),
  };
}

export function verifySignedAccountMoveNotice(
  notice: SignedAccountMoveNotice,
  publicKey: string,
): boolean {
  try {
    const { signature, ...payload } = notice;
    const verify = crypto.createVerify('sha256');
    verify.update(JSON.stringify(payload));
    return verify.verify(publicKey, signature, 'base64');
  } catch {
    return false;
  }
}

export async function deliverAccountMoveNotice(input: {
  sourceNode: string;
  sourceProtocol: 'http' | 'https';
  notice: SignedAccountMoveNotice;
}): Promise<void> {
  const response = await safeFederationRequest(
    `${input.sourceProtocol}://${input.sourceNode}/api/account/moved`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input.notice),
      timeoutMs: 5_000,
      maxResponseBytes: 64 * 1024,
    },
  );

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Old node returned ${response.status}`);
  }
  const confirmation = response.json();
  if (!isRecord(confirmation)
    || confirmation.success !== true
    || confirmation.sourceDataDeleted !== true
    || confirmation.usernameReserved !== true) {
    throw new Error('Old node did not confirm source cleanup');
  }
}
