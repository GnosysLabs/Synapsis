import { z } from 'zod';

import {
  federationMediaUrlSchema,
  nodeDomainSchema,
} from '@/lib/utils/federation';
import { getCanonicalSwarmSeedDomain, normalizeNodeDomain } from './node-domain';
import { resolveAccountAddress } from '@/lib/identity/account-address';

const MAX_REMOTE_LIST_USERS = 50;
const DEVELOPMENT_LOOPBACK_DOMAIN = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i;
const localHandleSchema = z.string().trim().min(1).max(64).regex(/^[a-zA-Z0-9_]+$/);

const remoteUserSummarySchema = z.object({
  handle: z.string().trim().min(1).max(320),
  displayName: z.string().trim().min(1).max(50).nullish(),
  avatarUrl: federationMediaUrlSchema.nullish(),
  bio: z.string().max(160).nullish(),
  isRemote: z.boolean(),
  isNsfw: z.boolean().optional(),
  nodeIsNsfw: z.boolean().optional(),
  nodeDomain: nodeDomainSchema,
}).strict();

const responseEnvelopeSchema = z.object({
  followers: z.unknown().optional(),
  following: z.unknown().optional(),
  restricted: z.boolean().optional(),
  nodeDomain: z.string().trim().min(1).max(255),
  timestamp: z.string().datetime(),
}).strict();

export type RemoteUserListKind = 'followers' | 'following';

export interface ParsedRemoteUserListEntry {
  id: string;
  handle: string;
  displayName: string;
  avatarUrl?: string;
  bio?: string;
  isRemote: true;
  isNsfw?: boolean;
  nodeIsNsfw?: boolean;
  nodeDomain: string;
  /** Internal provenance marker. Never serialize this field to clients. */
  isSourceOwned: boolean;
}

function developmentLoopbackDomain(value: string): string | null {
  const normalized = normalizeNodeDomain(value);
  return process.env.NODE_ENV === 'development' && DEVELOPMENT_LOOPBACK_DOMAIN.test(normalized)
    ? normalized
    : null;
}

/** Canonical public node identity accepted for outbound federation reads. */
export function canonicalizeRemoteUserListDomain(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  return getCanonicalSwarmSeedDomain(value) ?? developmentLoopbackDomain(value);
}

export function isValidRemoteUserListHandle(value: string): boolean {
  return localHandleSchema.safeParse(value).success;
}

function canonicalizeClaimedDomain(value: string): string {
  if (!nodeDomainSchema.safeParse(value).success) {
    throw new Error('Remote user list contains an invalid node domain');
  }
  const domain = canonicalizeRemoteUserListDomain(value);
  if (!domain) throw new Error('Remote user list contains a non-public node domain');
  return domain;
}

function canonicalizeEntry(
  rawEntry: z.infer<typeof remoteUserSummarySchema>,
  sourceDomain: string,
): ParsedRemoteUserListEntry {
  const claimedNodeDomain = canonicalizeClaimedDomain(rawEntry.nodeDomain);
  let address: ReturnType<typeof resolveAccountAddress>;

  if (rawEntry.isRemote) {
    address = resolveAccountAddress(rawEntry.handle);
    if (!address) {
      throw new Error('Remote user list contains a malformed federated handle');
    }
    if (canonicalizeClaimedDomain(address.homeDomain) !== claimedNodeDomain) {
      throw new Error('Remote user list handle and node domain do not match');
    }
  } else {
    address = resolveAccountAddress(rawEntry.handle, sourceDomain);
    if (!address) {
      throw new Error('Remote user list contains a malformed local handle');
    }
    if (claimedNodeDomain !== sourceDomain || address.homeDomain !== sourceDomain) {
      throw new Error('Remote user list attempted a cross-node local identity claim');
    }
  }

  const handle = address.canonical;
  return {
    id: handle,
    handle,
    displayName: rawEntry.displayName ?? address.username,
    avatarUrl: rawEntry.avatarUrl ?? undefined,
    bio: rawEntry.bio ?? undefined,
    isRemote: true,
    isNsfw: rawEntry.isNsfw,
    nodeIsNsfw: rawEntry.nodeIsNsfw,
    nodeDomain: address.homeDomain,
    isSourceOwned: address.homeDomain === sourceDomain,
  };
}

export function parseRemoteUserListResponse(
  value: unknown,
  sourceDomainInput: string,
  kind: RemoteUserListKind,
  requestedLimit: number,
): ParsedRemoteUserListEntry[] {
  const sourceDomain = canonicalizeRemoteUserListDomain(sourceDomainInput);
  if (!sourceDomain) throw new Error('Remote user list source domain is invalid');

  const envelope = responseEnvelopeSchema.safeParse(value);
  if (!envelope.success) throw new Error('Remote user list response failed validation');
  const responseDomain = canonicalizeRemoteUserListDomain(envelope.data.nodeDomain);
  if (responseDomain !== sourceDomain) {
    throw new Error('Remote user list returned a different node identity');
  }
  const otherKind: RemoteUserListKind = kind === 'followers' ? 'following' : 'followers';
  if (envelope.data[otherKind] !== undefined) {
    throw new Error('Remote user list returned an unexpected list type');
  }

  const limit = Math.min(MAX_REMOTE_LIST_USERS, Math.max(1, Math.trunc(requestedLimit)));
  const entries = z.array(remoteUserSummarySchema).max(limit).safeParse(envelope.data[kind]);
  if (!entries.success) throw new Error('Remote user list entries failed validation');

  const seenHandles = new Set<string>();
  const canonicalEntries: ParsedRemoteUserListEntry[] = [];
  for (const entry of entries.data) {
    const canonicalEntry = canonicalizeEntry(entry, sourceDomain);
    if (seenHandles.has(canonicalEntry.handle)) continue;
    seenHandles.add(canonicalEntry.handle);
    canonicalEntries.push(canonicalEntry);
  }
  return canonicalEntries;
}
