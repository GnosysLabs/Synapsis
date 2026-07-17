import { describe, expect, it } from 'vitest';
import {
    isPostSensitive,
    isRemoteAvatarSensitivityUnknown,
    isUserSensitive,
    redactSensitivePostForViewer,
    redactSensitiveUserSummary,
    serializePublicUserSummary,
    shouldHideSensitivePost,
} from './content-visibility';

describe('sensitive content visibility', () => {
    it('treats post, account, and node labels as sensitive', () => {
        expect(isPostSensitive({ postIsNsfw: true, authorIsNsfw: false, nodeIsNsfw: false, isRemote: false })).toBe(true);
        expect(isPostSensitive({ postIsNsfw: false, authorIsNsfw: true, nodeIsNsfw: false, isRemote: false })).toBe(true);
        expect(isPostSensitive({ postIsNsfw: false, authorIsNsfw: false, nodeIsNsfw: true, isRemote: true })).toBe(true);
    });

    it('fails closed for incomplete remote post metadata', () => {
        expect(isPostSensitive({ authorIsNsfw: false, nodeIsNsfw: false, isRemote: true })).toBe(true);
        expect(isPostSensitive({ postIsNsfw: false, nodeIsNsfw: false, isRemote: true })).toBe(true);
        expect(isPostSensitive({ postIsNsfw: false, authorIsNsfw: false, isRemote: true })).toBe(true);
        expect(isPostSensitive({ postIsNsfw: false, authorIsNsfw: false, nodeIsNsfw: false, isRemote: true })).toBe(false);
    });

    it('treats a bare-handle author with a remote node id as unknown remote content', () => {
        const restricted = redactSensitivePostForViewer({
            id: 'legacy-remote-placeholder-post',
            content: 'REMOTE CONTENT MUST NOT LEAK',
            media: [{ url: 'https://remote.example/private.jpg' }],
            author: {
                id: 'cached-remote-user',
                nodeId: 'remote-node-database-id',
                handle: 'bare_remote_handle',
                displayName: 'Remote User',
                avatarUrl: 'https://remote.example/avatar.jpg',
            },
        }, {
            canViewSensitive: false,
            localNodeDomain: 'local.example',
            localNodeIsNsfw: false,
        });

        expect(restricted).toMatchObject({
            content: '',
            media: [],
            sensitiveContentRestricted: true,
            author: {
                handle: 'bare_remote_handle',
                avatarUrl: null,
                isRemote: true,
                sensitiveRestricted: true,
            },
        });
        expect(restricted.author).not.toHaveProperty('nodeId');
        expect(JSON.stringify(restricted)).not.toContain('REMOTE CONTENT MUST NOT LEAK');
    });

    it('fails closed for incomplete remote profile metadata', () => {
        expect(isUserSensitive({ accountIsNsfw: false, isRemote: true })).toBe(true);
        expect(isUserSensitive({ nodeIsNsfw: false, isRemote: true })).toBe(true);
        expect(isUserSensitive({ accountIsNsfw: false, nodeIsNsfw: false, isRemote: true })).toBe(false);
    });

    it('hides sensitive posts until the viewer enables NSFW content', () => {
        const sensitivity = { postIsNsfw: true, authorIsNsfw: false, nodeIsNsfw: false, isRemote: false };
        expect(shouldHideSensitivePost({ sensitivity, viewer: null, localNodeIsNsfw: false })).toBe(true);
        expect(shouldHideSensitivePost({ sensitivity, viewer: { nsfwEnabled: false }, localNodeIsNsfw: false })).toBe(true);
        expect(shouldHideSensitivePost({
            sensitivity,
            viewer: { nsfwEnabled: true, ageVerifiedAt: '2026-07-17T00:00:00.000Z' },
            localNodeIsNsfw: false,
        })).toBe(false);
        expect(shouldHideSensitivePost({
            sensitivity,
            viewer: { nsfwEnabled: true, ageVerifiedAt: null },
            localNodeIsNsfw: false,
        })).toBe(true);
    });

    it('allows signed-in members of an adult-only node', () => {
        expect(shouldHideSensitivePost({
            sensitivity: { postIsNsfw: true, authorIsNsfw: true, nodeIsNsfw: true, isRemote: false },
            viewer: { nsfwEnabled: false, ageVerifiedAt: '2026-07-17T00:00:00.000Z' },
            localNodeIsNsfw: true,
        })).toBe(false);
    });

    it('keeps adult-node content hidden until age consent is persisted', () => {
        expect(shouldHideSensitivePost({
            sensitivity: { postIsNsfw: true, authorIsNsfw: true, nodeIsNsfw: true, isRemote: false },
            viewer: { nsfwEnabled: true, ageVerifiedAt: null },
            localNodeIsNsfw: true,
        })).toBe(true);
    });

    it('removes every raw sensitive field from a restricted response, including nested posts', () => {
        const restricted = redactSensitivePostForViewer({
            id: 'remote-post',
            isSwarm: true,
            nodeDomain: 'adult.example',
            nodeIsNsfw: true,
            isNsfw: false,
            content: 'SECRET POST BODY',
            media: [{ url: 'https://adult.example/secret-video.mp4' }],
            linkPreviewUrl: 'https://adult.example/secret-page',
            linkPreviewTitle: 'SECRET TITLE',
            linkPreviewDescription: 'SECRET DESCRIPTION',
            linkPreviewImage: 'https://adult.example/secret-preview.jpg',
            linkPreviewVideoUrl: 'https://adult.example/secret-preview.mp4',
            linkPreviewMediaJson: JSON.stringify([{ url: 'https://adult.example/secret-gallery.jpg' }]),
            swarmReplyToContent: 'SECRET PARENT BODY',
            swarmReplyToAuthor: {
                handle: 'parent@adult.example',
                avatarUrl: 'https://adult.example/secret-parent-avatar.jpg',
                nodeDomain: 'adult.example',
            },
            author: {
                handle: 'author@adult.example',
                avatarUrl: 'https://adult.example/secret-avatar.jpg',
                headerUrl: 'https://adult.example/secret-header.jpg',
                bio: 'SECRET BIO',
                website: 'https://adult.example/profile',
                isNsfw: false,
                nodeIsNsfw: true,
            },
            repostedBy: [{
                handle: 'reposter@adult.example',
                avatarUrl: 'https://adult.example/secret-reposter.jpg',
                isNsfw: true,
                nodeIsNsfw: true,
                nodeDomain: 'adult.example',
            }],
            repostOf: {
                id: 'nested-post',
                isSwarm: true,
                nodeDomain: 'adult.example',
                isNsfw: true,
                nodeIsNsfw: true,
                content: 'SECRET NESTED BODY',
                media: [{ url: 'https://adult.example/secret-nested.jpg' }],
                author: {
                    handle: 'nested@adult.example',
                    avatarUrl: 'https://adult.example/secret-nested-avatar.jpg',
                    isNsfw: true,
                    nodeIsNsfw: true,
                },
            },
            replyTo: {
                id: 'nested-reply-parent',
                isSwarm: true,
                nodeDomain: 'adult.example',
                isNsfw: true,
                nodeIsNsfw: true,
                content: 'SECRET REPLY PARENT',
                media: [{ url: 'https://adult.example/secret-reply-parent.jpg' }],
                author: {
                    handle: 'reply-parent@adult.example',
                    avatarUrl: 'https://adult.example/secret-reply-parent-avatar.jpg',
                    isNsfw: true,
                    nodeIsNsfw: true,
                },
            },
        }, {
            canViewSensitive: false,
            localNodeDomain: 'local.example',
            localNodeIsNsfw: false,
        });

        expect(restricted).toMatchObject({
            content: '',
            media: [],
            linkPreviewUrl: null,
            linkPreviewImage: null,
            sensitiveContentRestricted: true,
            author: { avatarUrl: null, headerUrl: null, bio: null, website: null },
            repostedBy: [{ avatarUrl: null, sensitiveRestricted: true }],
            repostOf: { content: '', media: [], sensitiveContentRestricted: true },
            replyTo: { content: '', media: [], sensitiveContentRestricted: true },
            swarmReplyToContent: null,
            swarmReplyToAuthor: { avatarUrl: null, sensitiveRestricted: true },
        });

        const serialized = JSON.stringify(restricted);
        for (const secret of [
            'SECRET',
            'secret-video.mp4',
            'secret-preview.jpg',
            'secret-gallery.jpg',
            'secret-avatar.jpg',
            'secret-reposter.jpg',
            'secret-nested.jpg',
            'secret-parent-avatar.jpg',
            'secret-reply-parent.jpg',
        ]) {
            expect(serialized).not.toContain(secret);
        }
    });

    it('parses legacy JSON-string reply authors before redaction', () => {
        const privateAvatar = 'https://adult.example/legacy-secret-avatar.jpg';
        const restricted = redactSensitivePostForViewer({
            id: 'legacy-reply',
            content: 'Safe reply body',
            isNsfw: false,
            author: {
                handle: 'local-author',
                isNsfw: false,
            },
            swarmReplyToId: 'swarm:adult.example:parent-id',
            swarmReplyToContent: 'LEGACY SECRET PARENT',
            swarmReplyToAuthor: JSON.stringify({
                handle: 'adult@adult.example',
                displayName: 'Adult account',
                avatarUrl: privateAvatar,
                nodeDomain: 'adult.example',
            }),
        }, {
            canViewSensitive: false,
            localNodeDomain: 'local.example',
            localNodeIsNsfw: false,
        });

        expect(restricted.swarmReplyToContent).toBeNull();
        expect(restricted.swarmReplyToAuthor).toMatchObject({
            handle: 'adult@adult.example',
            avatarUrl: null,
            isRemote: true,
            sensitiveRestricted: true,
        });
        expect(JSON.stringify(restricted)).not.toContain(privateAvatar);
        expect(JSON.stringify(restricted)).not.toContain('LEGACY SECRET PARENT');
    });

    it('drops malformed legacy reply-author metadata instead of serializing string characters', () => {
        const restricted = redactSensitivePostForViewer({
            id: 'malformed-legacy-reply',
            content: 'Reply',
            isNsfw: false,
            author: { handle: 'local-author', isNsfw: false },
            swarmReplyToId: 'swarm:remote.example:parent-id',
            swarmReplyToContent: 'Remote parent',
            swarmReplyToAuthor: '{"avatarUrl":"https://remote.example/broken.jpg"',
        }, {
            canViewSensitive: false,
            localNodeDomain: 'local.example',
            localNodeIsNsfw: false,
        });

        expect(restricted.swarmReplyToAuthor).toBeNull();
        expect(JSON.stringify(restricted)).not.toContain('broken.jpg');
    });

    it('rejects non-string legacy parent snapshots from hostile peers', () => {
        const restricted = redactSensitivePostForViewer({
            id: 'hostile-legacy-parent',
            content: 'Otherwise safe root',
            isSwarm: true,
            nodeDomain: 'remote.example',
            nodeIsNsfw: false,
            isNsfw: false,
            author: {
                handle: 'safe@remote.example',
                isNsfw: false,
                nodeIsNsfw: false,
            },
            swarmReplyToContent: { html: 'PRIVATE NSFW PARENT' },
        }, {
            canViewSensitive: true,
            localNodeDomain: 'local.example',
            localNodeIsNsfw: false,
        });

        expect(restricted.swarmReplyToContent).toBeNull();
        expect(JSON.stringify(restricted)).not.toContain('PRIVATE NSFW PARENT');
    });

    it('preserves explicitly safe content and authorized sensitive content', () => {
        const post = {
            id: 'safe-post',
            isSwarm: true,
            nodeDomain: 'remote.example',
            nodeIsNsfw: false,
            isNsfw: false,
            content: 'Visible body',
            media: [{ url: 'https://remote.example/image.jpg' }],
            author: {
                handle: 'author@remote.example',
                avatarUrl: 'https://remote.example/avatar.jpg',
                isNsfw: false,
                nodeIsNsfw: false,
            },
        };
        const options = {
            localNodeDomain: 'local.example',
            localNodeIsNsfw: false,
        };

        expect(redactSensitivePostForViewer(post, { ...options, canViewSensitive: false })).toMatchObject({
            content: 'Visible body',
            media: post.media,
            author: { avatarUrl: 'https://remote.example/avatar.jpg' },
        });
        expect(redactSensitivePostForViewer(
            { ...post, isNsfw: true },
            { ...options, canViewSensitive: true },
        )).toMatchObject({ content: 'Visible body', media: post.media });
    });

    it('reveals only the selected post body while keeping profiles and nested posts restricted', () => {
        const revealed = redactSensitivePostForViewer({
            id: 'selected-post',
            isSwarm: true,
            nodeDomain: 'adult.example',
            nodeIsNsfw: true,
            isNsfw: true,
            content: 'SELECTED BODY',
            media: [{ url: 'https://adult.example/selected.jpg' }],
            author: {
                handle: 'author@adult.example',
                avatarUrl: 'https://adult.example/avatar.jpg',
                isNsfw: true,
                nodeIsNsfw: true,
            },
            replyTo: {
                id: 'parent',
                isSwarm: true,
                nodeDomain: 'adult.example',
                nodeIsNsfw: true,
                isNsfw: true,
                content: 'PARENT SECRET',
                media: [{ url: 'https://adult.example/parent.jpg' }],
                author: {
                    handle: 'parent@adult.example',
                    avatarUrl: 'https://adult.example/parent-avatar.jpg',
                    isNsfw: true,
                    nodeIsNsfw: true,
                },
            },
        }, {
            canViewSensitive: false,
            revealSensitiveRoot: true,
            localNodeDomain: 'local.example',
            localNodeIsNsfw: false,
        });

        expect(revealed).toMatchObject({
            content: 'SELECTED BODY',
            media: [{ url: 'https://adult.example/selected.jpg' }],
            author: { avatarUrl: null, sensitiveRestricted: true },
            replyTo: {
                content: '',
                media: [],
                author: { avatarUrl: null, sensitiveRestricted: true },
                sensitiveContentRestricted: true,
            },
        });
        expect(JSON.stringify(revealed)).not.toContain('PARENT SECRET');
        expect(JSON.stringify(revealed)).not.toContain('parent-avatar.jpg');
    });

    it('drops unrecognized peer fields and private media metadata at every nesting level', () => {
        const serialized = redactSensitivePostForViewer({
            id: 'hostile-post',
            content: 'Known body',
            isSwarm: true,
            nodeDomain: 'adult.example',
            nodeIsNsfw: true,
            isNsfw: true,
            rawContent: 'ARBITRARY ROOT SECRET',
            attachments: [{ url: 'https://adult.example/arbitrary-attachment.jpg' }],
            media: [{
                id: 'media-id',
                url: 'https://adult.example/known-media.jpg',
                storageProvider: 'private-storage',
                storageAssetId: 'SECRET STORAGE ID',
                userId: 'SECRET USER ID',
            }],
            author: {
                handle: 'author@adult.example',
                isNsfw: true,
                nodeIsNsfw: true,
            },
            repostOf: {
                id: 'nested',
                content: 'Nested body',
                isSwarm: true,
                nodeDomain: 'adult.example',
                nodeIsNsfw: true,
                isNsfw: true,
                rawContent: 'ARBITRARY NESTED SECRET',
                author: {
                    handle: 'nested@adult.example',
                    isNsfw: true,
                    nodeIsNsfw: true,
                },
            },
        }, {
            canViewSensitive: true,
            localNodeDomain: 'local.example',
            localNodeIsNsfw: false,
        });

        const payload = JSON.stringify(serialized);
        expect(serialized).not.toHaveProperty('rawContent');
        expect(serialized).not.toHaveProperty('attachments');
        expect(serialized.repostOf).not.toHaveProperty('rawContent');
        expect(serialized.media?.[0]).toEqual({
            id: 'media-id',
            url: 'https://adult.example/known-media.jpg',
        });
        expect(payload).not.toContain('ARBITRARY');
        expect(payload).not.toContain('SECRET STORAGE');
        expect(payload).not.toContain('SECRET USER');
    });

    it('never serializes private account fields through post authors or reposter summaries', () => {
        const privateFields = {
            email: 'author@example.com',
            passwordHash: 'SECRET PASSWORD HASH',
            privateKeyEncrypted: 'SECRET PRIVATE SIGNING KEY',
            storageProvider: 's3',
            storageEndpoint: 'https://storage.internal.example',
            storageBucket: 'private-bucket',
            storageAccessKeyEncrypted: 'SECRET STORAGE ACCESS KEY',
            storageSecretKeyEncrypted: 'SECRET STORAGE SECRET KEY',
            nsfwEnabled: true,
            ageVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
            suspensionReason: 'PRIVATE MODERATION NOTE',
            silenceReason: 'PRIVATE SILENCE NOTE',
        };
        const author = {
            id: 'author-id',
            did: 'did:synapsis:author',
            handle: 'author',
            displayName: 'Public Author',
            avatarUrl: 'https://safe.example/avatar.jpg',
            publicKey: 'PUBLIC SIGNING KEY',
            isNsfw: false,
            nodeIsNsfw: false,
            ...privateFields,
        };
        const options = {
            canViewSensitive: true,
            localNodeDomain: 'safe.example',
            localNodeIsNsfw: false,
        };

        const serialized = redactSensitivePostForViewer({
            id: 'post-id',
            content: 'Public post body',
            isNsfw: false,
            author,
            repostedBy: [{
                ...author,
                id: 'reposter-id',
                handle: 'reposter',
                displayName: 'Public Reposter',
            }],
            swarmReplyToAuthor: {
                ...author,
                id: 'parent-id',
                handle: 'parent@safe.example',
                nodeDomain: 'safe.example',
            },
            repostOf: {
                id: 'nested-post',
                content: 'Nested public post',
                isNsfw: false,
                author: {
                    ...author,
                    id: 'nested-author-id',
                    handle: 'nested-author',
                },
            },
            replyTo: {
                id: 'reply-parent',
                content: 'Reply parent body',
                isNsfw: false,
                author: {
                    ...author,
                    id: 'reply-parent-author-id',
                    handle: 'reply-parent-author',
                },
            },
        }, options);

        expect(serialized.author).toMatchObject({
            id: 'author-id',
            did: 'did:synapsis:author',
            handle: 'author',
            displayName: 'Public Author',
            avatarUrl: 'https://safe.example/avatar.jpg',
            publicKey: 'PUBLIC SIGNING KEY',
            isNsfw: false,
            nodeIsNsfw: false,
        });
        expect(serialized.repostedBy?.[0]).toMatchObject({
            id: 'reposter-id',
            handle: 'reposter',
            displayName: 'Public Reposter',
        });
        expect(serialized.swarmReplyToAuthor).toMatchObject({
            id: 'parent-id',
            handle: 'parent@safe.example',
        });
        expect(serialized.repostOf?.author).toMatchObject({ handle: 'nested-author' });
        expect(serialized.replyTo?.author).toMatchObject({ handle: 'reply-parent-author' });

        const payload = JSON.stringify(serialized);
        for (const [key, value] of Object.entries(privateFields)) {
            expect(payload).not.toContain(key);
            if (typeof value === 'string') {
                expect(payload).not.toContain(value);
            }
        }
    });

    it('uses an explicit allowlist for public user summaries', () => {
        expect(serializePublicUserSummary({
            id: 'user-id',
            handle: 'public-user',
            displayName: 'Public User',
            avatarUrl: null,
            did: 'did:synapsis:public-user',
            publicKey: 'PUBLIC KEY',
            email: 'private@example.com',
            passwordHash: 'password hash',
            privateKeyEncrypted: 'encrypted private key',
            storageAccessKeyEncrypted: 'encrypted storage access key',
            storageSecretKeyEncrypted: 'encrypted storage secret key',
        })).toEqual({
            id: 'user-id',
            handle: 'public-user',
            displayName: 'Public User',
            avatarUrl: null,
            did: 'did:synapsis:public-user',
            publicKey: 'PUBLIC KEY',
        });
    });

    it('redacts sensitive profile media and biography without changing identity fields', () => {
        expect(redactSensitiveUserSummary({
            id: 'user-1',
            handle: 'adult@remote.example',
            isRemote: true,
            isNsfw: true,
            nodeIsNsfw: false,
            avatarUrl: 'https://remote.example/avatar.jpg',
            headerUrl: 'https://remote.example/header.jpg',
            bio: 'Sensitive bio',
            website: 'https://remote.example',
        }, false)).toEqual({
            id: 'user-1',
            handle: 'adult@remote.example',
            isRemote: true,
            isNsfw: true,
            nodeIsNsfw: false,
            avatarUrl: null,
            headerUrl: null,
            bio: null,
            website: null,
            sensitiveRestricted: true,
        });
    });
});

describe('remote avatar safety metadata', () => {
    it('fails closed when either remote classifier is missing', () => {
        expect(isRemoteAvatarSensitivityUnknown({
            seed: 'alice@remote.example',
            localNodeDomain: 'local.example',
            isNsfw: false,
        })).toBe(true);
    });

    it('accepts explicit safe metadata for a remote avatar', () => {
        expect(isRemoteAvatarSensitivityUnknown({
            seed: 'alice',
            nodeDomain: 'remote.example',
            localNodeDomain: 'local.example',
            isNsfw: false,
            nodeIsNsfw: false,
        })).toBe(false);
    });

    it('does not treat a local avatar as remotely unknown', () => {
        expect(isRemoteAvatarSensitivityUnknown({
            seed: 'alice',
            nodeDomain: 'local.example',
            localNodeDomain: 'local.example',
        })).toBe(false);
    });
});
