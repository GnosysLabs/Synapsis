import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@/db';
import { cliCredentials, users } from '@/db/schema';
import type { CliScope } from '@/lib/cli/scopes';
import { parseCliScopes } from '@/lib/cli/scopes';
import {
  recordVerifiedAction,
  SignedActionError,
  verifyCanonicalSignature,
} from '@/lib/auth/verify-signature';

export interface CliSignedAction<TData = Record<string, unknown>> {
  action: string;
  data: TData;
  credentialId: string;
  ts: number;
  nonce: string;
  sig: string;
}

export function isCliSignedAction(value: unknown): value is CliSignedAction<unknown> {
  if (!value || typeof value !== 'object') return false;
  const action = value as Record<string, unknown>;
  return typeof action.action === 'string'
    && typeof action.credentialId === 'string'
    && typeof action.ts === 'number'
    && typeof action.nonce === 'string'
    && typeof action.sig === 'string'
    && typeof action.data === 'object'
    && action.data !== null;
}

export async function requireCliSignedAction(
  signedAction: CliSignedAction<unknown>,
  expectedAction: string,
  requiredScope?: CliScope,
): Promise<{
  user: typeof users.$inferSelect;
  credential: typeof cliCredentials.$inferSelect;
}> {
  if (signedAction.action !== expectedAction) throw new SignedActionError('INVALID_ACTION');

  const now = Date.now();
  if (Math.abs(now - signedAction.ts) > 5 * 60 * 1000) {
    throw new SignedActionError('INVALID_TIMESTAMP');
  }

  const credential = await db.query.cliCredentials.findFirst({
    where: {
      AND: [
        { id: signedAction.credentialId },
        { revokedAt: { isNull: true } },
      ],
    },
    with: { user: true },
  });
  if (!credential) throw new SignedActionError('CREDENTIAL_NOT_FOUND');
  if (credential.expiresAt.getTime() <= now) throw new SignedActionError('CREDENTIAL_EXPIRED');
  if (credential.user.isSuspended || credential.user.isSilenced) {
    throw new SignedActionError('ACCOUNT_RESTRICTED');
  }

  const scopes = parseCliScopes(credential.scopes);
  if (requiredScope && !scopes.includes(requiredScope)) {
    throw new SignedActionError('INSUFFICIENT_SCOPE');
  }

  const signatureValid = await verifyCanonicalSignature(signedAction, credential.publicKey);
  if (!signatureValid) throw new SignedActionError('INVALID_SIGNATURE');

  const canonicalPayload = {
    action: signedAction.action,
    data: signedAction.data,
    credentialId: signedAction.credentialId,
    ts: signedAction.ts,
    nonce: signedAction.nonce,
  };
  const acceptanceError = await recordVerifiedAction({
    canonicalPayload,
    identity: `cli:${credential.id}`,
    rateLimitKey: `${credential.userId}:cli:${credential.id}:${signedAction.action}`,
    nonce: signedAction.nonce,
    ts: signedAction.ts,
    maxRequests: signedAction.action.startsWith('media_upload_') ? 10 : 5,
  });
  if (acceptanceError) throw new SignedActionError(acceptanceError);

  await db.update(cliCredentials)
    .set({ lastUsedAt: new Date() })
    .where(and(eq(cliCredentials.id, credential.id), isNull(cliCredentials.revokedAt)));

  return { user: credential.user, credential };
}

export function signedActionErrorStatus(error: SignedActionError): number {
  if (error.code === 'RATE_LIMITED') return 429;
  if (error.code === 'INVALID_ACTION') return 400;
  if (error.code === 'REPLAYED_NONCE') return 409;
  return 403;
}
