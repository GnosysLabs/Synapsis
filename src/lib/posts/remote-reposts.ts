import type { User } from '@/lib/types';
import { resolveAccountAddress } from '@/lib/identity/account-address';

export interface RemoteRepostSnapshot {
    postId: string;
    actorHandle: string;
    actorDisplayName: string | null;
    actorAvatarUrl: string | null;
    actorIsNsfw: boolean;
    actorNodeDomain: string;
    createdAt: Date;
}

export function mapRemoteReposter(repost: RemoteRepostSnapshot): User {
    const address = resolveAccountAddress(repost.actorHandle, repost.actorNodeDomain);
    if (!address || address.homeDomain !== repost.actorNodeDomain) {
        throw new Error('Remote repost actor address does not match its node');
    }

    return {
        id: `swarm:${repost.actorNodeDomain}:${address.username}`,
        handle: address.canonical,
        displayName: repost.actorDisplayName || repost.actorHandle,
        avatarUrl: repost.actorAvatarUrl,
        isRemote: true,
        isSwarm: true,
        isNsfw: repost.actorIsNsfw,
        nodeDomain: repost.actorNodeDomain,
    };
}

export function groupRemoteReposters(
    rows: RemoteRepostSnapshot[],
): Map<string, User[]> {
    const repostersByPostId = new Map<string, User[]>();

    for (const row of rows) {
        const reposter = mapRemoteReposter(row);
        const reposters = repostersByPostId.get(row.postId) || [];
        if (!reposters.some((actor) => actor.id === reposter.id)) {
            reposters.push(reposter);
        }
        repostersByPostId.set(row.postId, reposters);
    }

    return repostersByPostId;
}

export function attachRemoteRepostSummaries<
    TPost extends {
        id: string;
        repostsCount?: number;
        repostCount?: number;
        repostedBy?: User[];
        repostedByCount?: number;
    },
>(posts: TPost[], rows: RemoteRepostSnapshot[]): Array<TPost & {
    repostedBy?: User[];
    repostedByCount?: number;
}> {
    const remoteReposters = groupRemoteReposters(rows);

    return posts.map((post) => {
        const remoteActors = remoteReposters.get(post.id) || [];
        if (remoteActors.length === 0) return post;

        const existingActors = post.repostedBy || [];
        const repostedBy = [
            ...remoteActors,
            ...existingActors.filter((actor) => !remoteActors.some((remoteActor) => remoteActor.id === actor.id)),
        ];

        return {
            ...post,
            repostedBy,
            repostedByCount: Math.max(
                post.repostedByCount || 0,
                post.repostsCount || 0,
                post.repostCount || 0,
                repostedBy.length,
            ),
        };
    });
}
