export const parseRemoteHandle = (handle: string) => {
  const clean = handle.toLowerCase().replace(/^@/, '');
  const parts = clean.split('@').filter(Boolean);
  if (parts.length === 2) {
    return { handle: parts[0], domain: parts[1] };
  }
  return null;
};

export const getRemoteBaseUrl = (domain: string) =>
  domain.startsWith('http')
    ? domain
    : domain.startsWith('localhost') || domain.startsWith('127.0.0.1')
      ? `http://${domain}`
      : `https://${domain}`;

type RemoteProfilePost = {
  id: string;
  originalPostId?: string;
  author?: {
    id?: string;
    handle: string;
    displayName?: string | null;
    avatarUrl?: string | null;
    isBot?: boolean;
  };
  nodeDomain?: string | null;
  isSwarm?: boolean;
  repostOf?: RemoteProfilePost | null;
  replyTo?: RemoteProfilePost | null;
  media?: Array<{ id?: string; url: string; altText?: string | null; mimeType?: string | null }>;
  [key: string]: unknown;
};

export function mapRemoteProfilePost(post: RemoteProfilePost, remoteDomain: string): RemoteProfilePost {
  const isAlreadySwarm = post.id.startsWith('swarm:');
  const rawOriginalId = post.originalPostId || (isAlreadySwarm ? post.id.split(':').pop() || post.id : post.id);
  const effectiveDomain = post.nodeDomain || remoteDomain;

  return {
    ...post,
    id: isAlreadySwarm ? post.id : `swarm:${effectiveDomain}:${rawOriginalId}`,
    originalPostId: rawOriginalId,
    isSwarm: true,
    nodeDomain: effectiveDomain,
    author: post.author ? {
      ...post.author,
      id: post.author.id?.startsWith('swarm:')
        ? post.author.id
        : `swarm:${effectiveDomain}:${post.author.handle.includes('@') ? post.author.handle : post.author.handle}`,
      handle: post.author.handle.includes('@')
        ? post.author.handle
        : `${post.author.handle}@${effectiveDomain}`,
    } : post.author,
    media: post.media?.map((item, index) => ({
      ...item,
      id: item.id || `swarm:${effectiveDomain}:${rawOriginalId}:media:${index}`,
    })),
    repostOf: post.repostOf ? mapRemoteProfilePost(post.repostOf, remoteDomain) : post.repostOf,
    replyTo: post.replyTo ? mapRemoteProfilePost(post.replyTo, remoteDomain) : post.replyTo,
  };
}
