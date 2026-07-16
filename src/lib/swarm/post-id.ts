import { normalizeNodeDomain } from './node-domain';

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
