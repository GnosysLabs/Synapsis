import { resolveAccountAddress } from '@/lib/identity/account-address';
import {
  getCanonicalSwarmSeedDomain,
  getPublicSwarmDomain,
  normalizeNodeDomain,
} from './node-domain';

export interface RemoteUserHandle {
  handle: string;
  domain: string;
}

export interface ResolvedUserHandle {
  canonicalHandle: string;
  handle: string;
  domain: string | null;
  isQualified: boolean;
  isLocal: boolean;
  remote: RemoteUserHandle | null;
}

function canonicalizeDomain(value: string | null | undefined): string | null {
  if (!value) return null;

  const publicDomain = getPublicSwarmDomain(value);
  if (publicDomain) return getCanonicalSwarmSeedDomain(publicDomain) ?? publicDomain;

  const normalized = normalizeNodeDomain(value).replace(/\.$/, '');
  return normalized || null;
}

/**
 * Resolve a profile address relative to the current node. The returned
 * canonical handle is always qualified, including for accounts on this node.
 * Bare usernames are boundary aliases only.
 */
export function resolveUserHandle(
  value: string,
  currentDomain = process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:43821',
): ResolvedUserHandle {
  const localDomain = canonicalizeDomain(currentDomain);
  const address = resolveAccountAddress(value, localDomain);
  if (!address || !localDomain) {
    const clean = value.trim().toLowerCase().replace(/^@/, '');
    return {
      canonicalHandle: clean,
      handle: clean,
      domain: null,
      isQualified: false,
      isLocal: false,
      remote: null,
    };
  }
  const clean = value.trim().replace(/^@/, '');
  const isQualified = clean.includes('@');
  const isLocal = address.homeDomain === localDomain;

  return {
    canonicalHandle: address.canonical,
    handle: address.username,
    domain: address.homeDomain,
    isQualified,
    isLocal,
    remote: isLocal ? null : { handle: address.username, domain: address.homeDomain },
  };
}
