import { getPublicSwarmDomain, normalizeNodeDomain } from './node-domain';

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
  if (publicDomain) return publicDomain;

  const normalized = normalizeNodeDomain(value).replace(/\.$/, '');
  return normalized || null;
}

/**
 * Resolve a profile handle relative to the current node.
 *
 * Fully-qualified handles remain remote unless their domain identifies this
 * node. A same-node handle such as `alice@social.example` is canonicalized to
 * the local database handle `alice` so every profile sub-route behaves the
 * same way.
 */
export function resolveUserHandle(
  value: string,
  currentDomain = process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:43821',
): ResolvedUserHandle {
  const clean = value.trim().toLowerCase().replace(/^@/, '');
  const parts = clean.split('@');

  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return {
      canonicalHandle: clean,
      handle: clean,
      domain: null,
      isQualified: false,
      isLocal: true,
      remote: null,
    };
  }

  const handle = parts[0];
  const domain = canonicalizeDomain(parts[1]);
  if (!domain) {
    return {
      canonicalHandle: clean,
      handle: clean,
      domain: null,
      isQualified: false,
      isLocal: true,
      remote: null,
    };
  }

  const localDomain = canonicalizeDomain(currentDomain);
  const isLocal = localDomain !== null && domain === localDomain;

  return {
    canonicalHandle: isLocal ? handle : `${handle}@${domain}`,
    handle,
    domain,
    isQualified: true,
    isLocal,
    remote: isLocal ? null : { handle, domain },
  };
}
