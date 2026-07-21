import { z } from 'zod';

import { signedUserActionSchema } from '@/lib/e2ee/protocol';

export const PROFILE_DOCUMENT_PROTOCOL = 'synapsis-profile-v1' as const;
export const PUBLISH_PROFILE_ACTION = 'publish_profile' as const;

const nullableUrl = z.url().max(2_048).nullable();

/**
 * Complete public presentation signed by the account key. Private preferences,
 * counters, node classification, and third-party attestations deliberately do
 * not belong in this user-owned document.
 */
export const profileDocumentDataSchema = z.strictObject({
  protocol: z.literal(PROFILE_DOCUMENT_PROTOCOL),
  displayName: z.string().min(1).max(50),
  bio: z.string().max(160).nullable(),
  avatarUrl: nullableUrl,
  headerUrl: nullableUrl,
  website: nullableUrl,
});

export const signedProfileDocumentSchema = signedUserActionSchema.extend({
  action: z.literal(PUBLISH_PROFILE_ACTION),
  data: profileDocumentDataSchema,
});

export type ProfileDocumentData = z.infer<typeof profileDocumentDataSchema>;
export type SignedProfileDocument = z.infer<typeof signedProfileDocumentSchema>;

export interface PublicProfilePresentation {
  displayName: string;
  bio?: string | null;
  avatarUrl?: string | null;
  headerUrl?: string | null;
  website?: string | null;
}

function nullable(value: string | null | undefined): string | null {
  return value || null;
}

export function buildProfileDocumentData(
  presentation: PublicProfilePresentation,
): ProfileDocumentData {
  return profileDocumentDataSchema.parse({
    protocol: PROFILE_DOCUMENT_PROTOCOL,
    displayName: presentation.displayName,
    bio: nullable(presentation.bio),
    avatarUrl: nullable(presentation.avatarUrl),
    headerUrl: nullable(presentation.headerUrl),
    website: nullable(presentation.website),
  });
}

export function profileDocumentMatchesPresentation(
  document: SignedProfileDocument,
  presentation: PublicProfilePresentation,
): boolean {
  return document.data.displayName === presentation.displayName
    && document.data.bio === nullable(presentation.bio)
    && document.data.avatarUrl === nullable(presentation.avatarUrl)
    && document.data.headerUrl === nullable(presentation.headerUrl)
    && document.data.website === nullable(presentation.website);
}

export function parseStoredProfileDocument(value: string | null | undefined): SignedProfileDocument | null {
  if (!value) return null;
  try {
    const parsed = signedProfileDocumentSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
