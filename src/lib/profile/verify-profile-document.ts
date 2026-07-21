import { verifyActionSignature } from '@/lib/auth/verify-signature';
import { didKeyMatchesPublicKey, normalizeSigningPublicKey } from '@/lib/crypto/did-key';
import { resolveAccountAddress } from '@/lib/identity/account-address';
import {
  profileDocumentMatchesPresentation,
  signedProfileDocumentSchema,
  type PublicProfilePresentation,
  type SignedProfileDocument,
} from './profile-document';

const MAX_FUTURE_SKEW_MS = 5 * 60 * 1_000;

export interface ProfileDocumentIdentity extends PublicProfilePresentation {
  handle: string;
  did: string;
  publicKey: string;
}

/** Verify identity, exact presentation, freshness direction, and user signature. */
export async function verifyProfileDocument(
  value: unknown,
  expected: ProfileDocumentIdentity,
): Promise<SignedProfileDocument | null> {
  const parsed = signedProfileDocumentSchema.safeParse(value);
  if (!parsed.success) return null;
  const document = parsed.data;
  const expectedAddress = resolveAccountAddress(expected.handle);
  const documentAddress = resolveAccountAddress(document.handle);
  if (!expectedAddress
    || !documentAddress
    || documentAddress.canonical !== expectedAddress.canonical
    || document.did !== expected.did
    || document.ts > Date.now() + MAX_FUTURE_SKEW_MS
    || !profileDocumentMatchesPresentation(document, expected)) {
    return null;
  }

  const publicKey = normalizeSigningPublicKey(expected.publicKey);
  if (!publicKey
    || !didKeyMatchesPublicKey(expected.did, publicKey)
    || !await verifyActionSignature(document, publicKey)) {
    return null;
  }
  return document;
}
