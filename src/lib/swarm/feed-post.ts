import type { SwarmPost } from '@/app/api/swarm/timeline/route';
import type { Post } from '@/lib/types';

export type InteractiveSwarmPost = SwarmPost & {
    isLiked?: boolean;
    isReposted?: boolean;
};

export function mapSwarmPostToPost(post: InteractiveSwarmPost): Post {
    const normalizedId = `swarm:${post.nodeDomain}:${post.id}`;

    return {
        id: normalizedId,
        originalPostId: post.id,
        content: post.content,
        createdAt: post.createdAt,
        likesCount: post.likeCount,
        repostsCount: post.repostCount,
        repliesCount: post.replyCount,
        isSwarm: true,
        nodeDomain: post.nodeDomain,
        repostOfId: post.repostOfId
            ? `swarm:${post.nodeDomain}:${post.repostOfId}`
            : null,
        repostOf: post.repostOf
            ? mapSwarmPostToPost(post.repostOf as InteractiveSwarmPost)
            : null,
        author: {
            id: `swarm:${post.nodeDomain}:${post.author.handle}`,
            handle: post.author.handle,
            displayName: post.author.displayName,
            avatarUrl: post.author.avatarUrl,
            isSwarm: true,
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
