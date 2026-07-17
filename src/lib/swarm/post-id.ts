import { getPublicSwarmDomain, normalizeNodeDomain } from './node-domain';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEVELOPMENT_LOOPBACK_DOMAIN = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i;

export interface ParsedSwarmPostId {
  domain: string;
  originalPostId: string;
}

/** Parse only canonical, remotely fetchable swarm post identifiers. */
export function parseSwarmPostId(postId: string): ParsedSwarmPostId | null {
  const domain = extractSwarmPostDomain(postId);
  const originalPostId = extractOriginalSwarmPostId(postId);
  if (!domain || !originalPostId || !UUID_PATTERN.test(originalPostId)) return null;

  const normalized = normalizeNodeDomain(domain);
  const publicDomain = getPublicSwarmDomain(normalized);
  const developmentDomain = process.env.NODE_ENV === 'development'
    && DEVELOPMENT_LOOPBACK_DOMAIN.test(normalized)
    ? normalized
    : null;
  const canonicalDomain = publicDomain ?? developmentDomain;
  if (!canonicalDomain || domain !== canonicalDomain) return null;

  return { domain: canonicalDomain, originalPostId };
}

export function extractSwarmPostDomain(postId: string): string | null {
  if (!postId.startsWith('swarm:')) return null;
  const lastColonIndex = postId.lastIndexOf(':');
  if (lastColonIndex <= 6) return null;
  return postId.substring(6, lastColonIndex);
}

export function extractOriginalSwarmPostId(postId: string): string | null {
  if (!postId.startsWith('swarm:')) return null;
  const lastColonIndex = postId.lastIndexOf(':');
  if (lastColonIndex <= 6 || lastColonIndex === postId.length - 1) return null;
  return postId.substring(lastColonIndex + 1);
}

export function isLocalSwarmDomain(domain: string | null | undefined, localDomain: string | null | undefined): boolean {
  if (!domain || !localDomain) return false;
  return normalizeNodeDomain(domain) === normalizeNodeDomain(localDomain);
}

export function normalizeSameNodePostId(postId: string, localDomain: string): string {
  const domain = extractSwarmPostDomain(postId);
  const originalPostId = extractOriginalSwarmPostId(postId);

  return domain && originalPostId && isLocalSwarmDomain(domain, localDomain)
    ? originalPostId
    : postId;
}
