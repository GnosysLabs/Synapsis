import type { Post } from '@/lib/types';

export interface NodeFeedReposter {
    id: string;
    handle: string;
    displayName: string | null;
    avatarUrl: string | null;
    isNsfw: boolean;
    nodeDomain?: string | null;
}

interface NodeFeedActivity {
    storyId: string;
    latestActivityAt: Date;
}

interface NodeFeedRepostRow {
    repostOfId: string | null;
    author: NodeFeedReposter;
}

export type NodeFeedStory<TPost> = TPost & {
    feedActivityAt: string;
    repostedBy: NodeFeedReposter[];
    repostedByCount: number;
};

/**
 * Build one Node-feed story per original post while retaining every unique
 * reposter for the compact activity summary.
 */
export function assembleNodeFeedStories<TPost extends { id: string; repostsCount?: number }>(
    activityRows: NodeFeedActivity[],
    originalPosts: TPost[],
    repostRows: NodeFeedRepostRow[],
): Array<NodeFeedStory<TPost>> {
    const postsById = new Map(originalPosts.map((post) => [post.id, post]));
    const repostersByPostId = new Map<string, NodeFeedReposter[]>();

    for (const repost of repostRows) {
        if (!repost.repostOfId) continue;
        const reposters = repostersByPostId.get(repost.repostOfId) || [];
        if (!reposters.some((actor) => actor.id === repost.author.id)) {
            reposters.push(repost.author);
        }
        repostersByPostId.set(repost.repostOfId, reposters);
    }

    return activityRows.flatMap((activity) => {
        const post = postsById.get(activity.storyId);
        if (!post) return [];
        const repostedBy = repostersByPostId.get(activity.storyId) || [];

        return [{
            ...post,
            feedActivityAt: activity.latestActivityAt.toISOString(),
            repostedBy,
            repostedByCount: Math.max(repostedBy.length, post.repostsCount || 0),
        }];
    });
}

function activityTimestamp(post: Post): number {
    return new Date(post.feedActivityAt || post.createdAt).getTime();
}

/**
 * Collapse repost wrapper events for shared feeds. Profile timelines deliberately
 * do not call this helper because there the wrapper is part of the user's history.
 */
export function collapseSharedFeedPosts(posts: Post[]): Post[] {
    const stories = new Map<string, Post>();
    const orderedEvents = [...posts].sort((a, b) => activityTimestamp(b) - activityTimestamp(a));

    for (const event of orderedEvents) {
        const original = event.repostOf || event;
        const storyId = original.id;
        const existing = stories.get(storyId);
        const existingReposters = existing?.repostedBy || [];
        const eventReposter = event.repostOf ? event.author : null;
        const repostedBy = eventReposter && !existingReposters.some((actor) => actor.id === eventReposter.id)
            ? [...existingReposters, eventReposter]
            : existingReposters;
        const feedActivityAt = new Date(Math.max(
            existing ? activityTimestamp(existing) : 0,
            activityTimestamp(event),
        )).toISOString();
        const repostedByCount = Math.max(
            existing?.repostedByCount || 0,
            original.repostsCount || 0,
            repostedBy.length,
        );

        stories.set(storyId, {
            ...(existing || original),
            ...(event.repostOf ? {} : event),
            repostedBy,
            repostedByCount,
            feedActivityAt,
        });
    }

    return Array.from(stories.values())
        .sort((a, b) => activityTimestamp(b) - activityTimestamp(a));
}
