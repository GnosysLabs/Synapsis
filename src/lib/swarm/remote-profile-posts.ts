import { resolveUserHandle } from './user-handle';
import { resolveAccountAddress } from '@/lib/identity/account-address';

export const parseRemoteHandle = (handle: string) => resolveUserHandle(handle).remote;

export const getRemoteBaseUrl = (domain: string) =>
  domain.startsWith('http')
    ? domain
    : domain.startsWith('localhost') || domain.startsWith('127.0.0.1')
      ? `http://${domain}`
      : `https://${domain}`;

export type RemoteProfilePost = {
  id: string;
  createdAt: string;
  originalPostId?: string;
  author?: {
    id?: string;
    handle: string;
    displayName?: string | null;
    avatarUrl?: string | null;
    isNsfw?: boolean;
    nodeIsNsfw?: boolean;
    nodeDomain?: string | null;
  };
  nodeDomain?: string | null;
  isSwarm?: boolean;
  repostOf?: RemoteProfilePost | null;
  replyTo?: RemoteProfilePost | null;
  repostedBy?: Array<{
    id?: string;
    handle: string;
    displayName?: string | null;
    avatarUrl?: string | null;
    isNsfw?: boolean;
    nodeIsNsfw?: boolean;
    nodeDomain?: string | null;
  }>;
  repostedByCount?: number;
  media?: Array<{ id?: string; url: string; altText?: string | null; mimeType?: string | null }>;
  [key: string]: unknown;
};

export function mapRemoteProfilePost(post: RemoteProfilePost, remoteDomain: string): RemoteProfilePost {
  const isAlreadySwarm = post.id.startsWith('swarm:');
  const rawOriginalId = post.originalPostId || (isAlreadySwarm ? post.id.split(':').pop() || post.id : post.id);
  const effectiveDomain = post.nodeDomain || remoteDomain;
  const authorAddress = post.author
    ? resolveAccountAddress(post.author.handle, effectiveDomain)
    : null;
  if (post.author && (!authorAddress || authorAddress.homeDomain !== effectiveDomain)) {
    throw new Error('Remote profile post author address does not match its node');
  }

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
        : `swarm:${effectiveDomain}:${authorAddress!.username}`,
      handle: authorAddress!.canonical,
    } : post.author,
    media: post.media?.map((item, index) => ({
      ...item,
      id: item.id || `swarm:${effectiveDomain}:${rawOriginalId}:media:${index}`,
    })),
    repostedBy: post.repostedBy?.map((reposter) => {
      const reposterDomain = reposter.nodeDomain || effectiveDomain;
      const address = resolveAccountAddress(reposter.handle, reposterDomain);
      if (!address || address.homeDomain !== reposterDomain) {
        throw new Error('Remote profile reposter address does not match its node');
      }
      return {
        ...reposter,
        id: reposter.id?.startsWith('swarm:')
          ? reposter.id
          : `swarm:${reposterDomain}:${address.username}`,
        handle: address.canonical,
        nodeDomain: reposterDomain,
      };
    }),
    repostOf: post.repostOf ? mapRemoteProfilePost(post.repostOf, remoteDomain) : post.repostOf,
    replyTo: post.replyTo ? mapRemoteProfilePost(post.replyTo, remoteDomain) : post.replyTo,
  };
}
