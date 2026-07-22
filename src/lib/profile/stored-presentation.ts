import {
  requireCanonicalAccountHomeDomain,
  resolveAccountAddress,
} from '@/lib/identity/account-address';
import { redactSensitiveUserSummary } from '@/lib/nsfw/content-visibility';
import { stuffboxBadgeFromStoredUser } from '@/lib/stuffbox/badge';
import type { StuffboxBadge } from '@/lib/types';

export interface StoredPresentationUser {
  handle: string;
  displayName?: string | null;
  avatarUrl?: string | null;
  did?: string | null;
  isNsfw?: boolean | null;
  isLocalAccount?: boolean | null;
  homeDomain?: string | null;
  profileVersion?: number | null;
  profileDocumentJson?: string | null;
  stuffboxBadgeProof?: string | null;
  stuffboxBadgeLevel?: string | null;
  stuffboxBadgePlan?: string | null;
  stuffboxBadgeIssuer?: string | null;
  stuffboxBadgeExpiresAt?: Date | string | null;
}

export interface ProfilePresentation {
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  did: string | null;
  nodeDomain: string;
  isNsfw?: boolean;
  nodeIsNsfw?: boolean;
  stuffboxBadge: StuffboxBadge | null;
  profilePresentationVerified: boolean;
  profileVersion: number | null;
  sensitiveRestricted?: boolean;
}

/**
 * The one conversion boundary from a stored account row to UI presentation.
 * Remote names, avatars, and classifiers are usable only when they are backed
 * by the account's signed, versioned profile document. Every endpoint that
 * renders an account should call this instead of interpreting the user row.
 */
export function storedProfilePresentation(
  user: StoredPresentationUser,
  {
    localNodeDomain: localNodeDomainInput,
    localNodeIsNsfw,
    canViewSensitive,
    remoteNodeIsNsfw,
  }: {
    localNodeDomain: string;
    localNodeIsNsfw: boolean;
    canViewSensitive: boolean;
    remoteNodeIsNsfw?: boolean;
  },
): ProfilePresentation | null {
  const localNodeDomain = requireCanonicalAccountHomeDomain(localNodeDomainInput);
  const address = resolveAccountAddress(user.handle, user.homeDomain || localNodeDomain);
  if (!address) return null;

  const isRemote = user.isLocalAccount === false || address.homeDomain !== localNodeDomain;
  const profilePresentationVerified = !isRemote || Boolean(
    user.profileVersion && user.profileDocumentJson,
  );
  const displayName = profilePresentationVerified
    ? user.displayName?.trim() || address.username
    : address.username;
  const summary = redactSensitiveUserSummary({
    handle: address.canonical,
    displayName,
    avatarUrl: profilePresentationVerified ? user.avatarUrl?.trim() || null : null,
    did: user.did || null,
    nodeDomain: address.homeDomain,
    isRemote,
    isNsfw: isRemote
      ? profilePresentationVerified && typeof user.isNsfw === 'boolean'
        ? user.isNsfw
        : undefined
      : user.isNsfw ?? false,
    nodeIsNsfw: isRemote ? remoteNodeIsNsfw : localNodeIsNsfw,
    stuffboxBadge: stuffboxBadgeFromStoredUser(user),
  }, canViewSensitive);

  return {
    handle: address.canonical,
    displayName: summary.displayName,
    avatarUrl: summary.avatarUrl,
    did: summary.did,
    nodeDomain: address.homeDomain,
    isNsfw: summary.isNsfw,
    nodeIsNsfw: summary.nodeIsNsfw,
    stuffboxBadge: summary.stuffboxBadge,
    profilePresentationVerified,
    profileVersion: profilePresentationVerified ? user.profileVersion ?? null : null,
    ...(summary.sensitiveRestricted ? { sensitiveRestricted: true } : {}),
  };
}
