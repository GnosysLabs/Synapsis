import type { Post } from '@/lib/types';

export interface NodeFeedReposter {
    id: string;
    handle: string;
    displayName: string | null;
    avatarUrl: string | null;
    isNsfw: boolean;
    nodeDomain?: string | null;
}

export interface NodeFeedActivity {
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

export interface RepostSummary<TReposter> {
    repostedBy: TReposter[];
    repostedByCount: number;
}

/**
 * Keep one actor's presence in a repost summary deterministic. Included actors
 * are placed first so the active viewer remains visible inside the three-avatar
 * limit, while the supplied count remains the source of truth for hidden actors.
 */
export function setReposterInSummary<TReposter extends { id: string }>(
    repostedBy: TReposter[] | undefined,
    repostedByCount: number | undefined,
    reposter: TReposter,
    included: boolean,
): RepostSummary<TReposter> {
    const otherReposters = (repostedBy || []).filter((actor) => actor.id !== reposter.id);
    const nextReposters = included ? [reposter, ...otherReposters] : otherReposters;

    return {
        repostedBy: nextReposters,
        repostedByCount: Math.max(repostedByCount || 0, nextReposters.length),
    };
}

export function mergeNodeFeedActivities(
    sources: NodeFeedActivity[][],
    limit: number,
): NodeFeedActivity[] {
    const latestByStoryId = new Map<string, Date>();

    for (const source of sources) {
        for (const activity of source) {
            const current = latestByStoryId.get(activity.storyId);
            if (!current || activity.latestActivityAt > current) {
                latestByStoryId.set(activity.storyId, activity.latestActivityAt);
            }
        }
    }

    return Array.from(latestByStoryId, ([storyId, latestActivityAt]) => ({
        storyId,
        latestActivityAt,
    }))
        .sort((a, b) => b.latestActivityAt.getTime() - a.latestActivityAt.getTime())
        .slice(0, limit);
}

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
        const eventReposter = event.repostOf ? event.author : null;
        const repostedBy = [
            ...(existing?.repostedBy || []),
            ...(original.repostedBy || []),
            ...(event.repostedBy || []),
            ...(eventReposter ? [eventReposter] : []),
        ].filter((actor, index, actors) =>
            actors.findIndex((candidate) => candidate.id === actor.id) === index);
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
