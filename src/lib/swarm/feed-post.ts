import type { SwarmPost } from '@/app/api/swarm/timeline/route';
import type { Post } from '@/lib/types';
import { isLocalSwarmDomain } from './post-id';
import { resolveAccountAddress } from '@/lib/identity/account-address';

export type InteractiveSwarmPost = SwarmPost & {
    isLiked?: boolean;
    isReposted?: boolean;
};

export function mapSwarmPostToPost(
    post: InteractiveSwarmPost,
    options: { localDomain?: string | null } = {}
): Post {
    const isLocalPost = isLocalSwarmDomain(post.nodeDomain, options.localDomain);
    const normalizedId = isLocalPost ? post.id : `swarm:${post.nodeDomain}:${post.id}`;
    const authorAddress = resolveAccountAddress(post.author.handle, post.nodeDomain);
    if (!authorAddress || authorAddress.homeDomain !== post.nodeDomain) {
        throw new Error('Swarm post author address does not match its node');
    }

    return {
        id: normalizedId,
        originalPostId: post.id,
        content: post.content,
        createdAt: post.createdAt,
        feedActivityAt: post.feedActivityAt,
        likesCount: post.likeCount,
        repostsCount: post.repostCount,
        repliesCount: post.replyCount,
        isNsfw: post.isNsfw,
        nodeIsNsfw: post.nodeIsNsfw,
        originUnavailable: post.originUnavailable,
        isSwarm: !isLocalPost,
        nodeDomain: post.nodeDomain,
        repostOfId: post.repostOfId
            ? (isLocalPost ? post.repostOfId : `swarm:${post.nodeDomain}:${post.repostOfId}`)
            : null,
        repostOf: post.repostOf
            ? mapSwarmPostToPost(post.repostOf as InteractiveSwarmPost, options)
            : null,
        repostedBy: post.repostedBy?.map((reposter) => {
            const reposterDomain = reposter.nodeDomain || post.nodeDomain;
            const address = resolveAccountAddress(reposter.handle, reposterDomain);
            if (!address || address.homeDomain !== reposterDomain) {
                throw new Error('Swarm reposter address does not match its node');
            }
            return {
                ...reposter,
                id: reposter.id?.startsWith('swarm:')
                    ? reposter.id
                    : `swarm:${reposterDomain}:${address.username}`,
                handle: address.canonical,
                nodeDomain: reposterDomain,
                isSwarm: true,
                isRemote: true,
            };
        }),
        repostedByCount: post.repostedByCount,
        author: {
            id: `swarm:${post.nodeDomain}:${authorAddress.username}`,
            handle: authorAddress.canonical,
            displayName: post.author.displayName,
            avatarUrl: post.author.avatarUrl,
            isSwarm: !isLocalPost,
            isNsfw: post.author.isNsfw,
            nodeIsNsfw: post.nodeIsNsfw,
            nodeDomain: post.nodeDomain,
        },
        media: post.media?.map((item, index) => ({
            id: `${normalizedId}:media:${index}`,
            url: item.url,
            altText: item.altText || null,
            mimeType: item.mimeType || null,
        })) || [],
        linkPreviewUrl: post.linkPreviewUrl || null,
        linkPreviewTitle: post.linkPreviewTitle || null,
        linkPreviewDescription: post.linkPreviewDescription || null,
        linkPreviewImage: post.linkPreviewImage || null,
        linkPreviewType: post.linkPreviewType || null,
        linkPreviewVideoUrl: post.linkPreviewVideoUrl || null,
        linkPreviewMedia: post.linkPreviewMedia || null,
        isLiked: post.isLiked || false,
        isReposted: post.isReposted || false,
    };
}
