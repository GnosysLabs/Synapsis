import { describe, expect, it } from 'vitest';
import {
    attachRemoteRepostSummaries,
    mapRemoteReposter,
    type RemoteRepostSnapshot,
} from './remote-reposts';

const remoteRepost = (overrides: Partial<RemoteRepostSnapshot> = {}): RemoteRepostSnapshot => ({
    postId: 'post-1',
    actorHandle: 'alice',
    actorDisplayName: 'Alice',
    actorAvatarUrl: 'https://remote.example/alice.png',
    actorIsNsfw: false,
    actorNodeDomain: 'remote.example',
    createdAt: new Date('2026-07-16T15:00:00Z'),
    ...overrides,
});

describe('remote repost summaries', () => {
    it('maps a federated actor to a stable swarm identity', () => {
        expect(mapRemoteReposter(remoteRepost())).toMatchObject({
            id: 'swarm:remote.example:alice',
            handle: 'alice@remote.example',
            displayName: 'Alice',
            avatarUrl: 'https://remote.example/alice.png',
            nodeDomain: 'remote.example',
            isSwarm: true,
        });
    });

    it('attaches unique remote actors while preserving local reposters and the total', () => {
        const localReposter = {
            id: 'local-user',
            handle: 'local-user',
            displayName: 'Local User',
        };
        const [post] = attachRemoteRepostSummaries([{
            id: 'post-1',
            repostsCount: 4,
            repostedBy: [localReposter],
            repostedByCount: 4,
        }], [
            remoteRepost(),
            remoteRepost(),
            remoteRepost({
                actorHandle: 'bob',
                actorDisplayName: 'Bob',
                actorAvatarUrl: null,
            }),
        ]);

        expect(post.repostedBy?.map((actor) => actor.id)).toEqual([
            'swarm:remote.example:alice',
            'swarm:remote.example:bob',
            'local-user',
        ]);
        expect(post.repostedByCount).toBe(4);
    });
});
