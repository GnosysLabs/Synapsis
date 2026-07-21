import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db, posts, users } from '@/db';
import { eq, sql } from 'drizzle-orm';
import { parseLinkPreviewMediaJson } from '@/lib/media/linkPreview';
import { normalizeSameNodePostId, parseSwarmPostId } from '@/lib/swarm/post-id';
import { attachRemoteRepostSummaries } from '@/lib/posts/remote-reposts';
import {
    SENSITIVE_PROFILE_MESSAGE,
} from '@/lib/nsfw/remote-profile-access';
import { isPostSensitive, redactSensitivePostForViewer } from '@/lib/nsfw/content-visibility';
import { getSensitiveContentViewerAccess } from '@/lib/nsfw/viewer-access';
import { signedFederationRead } from '@/lib/swarm/signed-read';
import {
    getKnownSwarmNodeNsfw,
    getPinnedSwarmNodePublicKey,
} from '@/lib/swarm/registry';
import { safeFederationRequest } from '@/lib/swarm/safe-federation-http';
import { createSignedPayload, verifySwarmRequest } from '@/lib/swarm/signature';
import { normalizeNodeDomain } from '@/lib/swarm/node-domain';
import { requireSignedAction } from '@/lib/auth/verify-signature';
import { signedUserActionSchema, type SignedUserAction } from '@/lib/e2ee/protocol';
import {
    createFederationActionContext,
    pinVerifiedFederatedActorIdentity,
} from '@/lib/swarm/federated-action';
import {
    parseRemotePostDetailResponse,
    parseRemoteRepliesResponse,
} from '@/lib/swarm/remote-post-payload';
import {
    requireCanonicalAccountHomeDomain,
    resolveAccountAddress,
} from '@/lib/identity/account-address';

interface SwarmReplyDeletionPayload {
    replyId: string;
    nodeDomain: string;
    authorHandle: string;
}

async function sendSignedSwarmReplyDeletion(
    originDomain: string,
    deletion: SwarmReplyDeletionPayload,
    userAction: SignedUserAction,
) {
    const protocol = originDomain.includes('localhost') ? 'http' : 'https';
    const signedDeletion = {
        federation: createFederationActionContext({
            destinationDomain: originDomain,
            method: 'DELETE',
            path: '/api/swarm/replies',
        }),
        userAction,
        ...deletion,
        timestamp: new Date().toISOString(),
    };
    const { payload, signature } = await createSignedPayload(signedDeletion);
    return safeFederationRequest(`${protocol}://${originDomain}/api/swarm/replies`, {
        method: 'DELETE',
        headers: {
            'Content-Type': 'application/json',
            'X-Swarm-Source-Domain': deletion.nodeDomain,
            'X-Swarm-Signature': signature,
        },
        body: JSON.stringify(payload),
        timeoutMs: 5_000,
        maxResponseBytes: 64 * 1024,
    });
}

const embeddedPostRelations = {
    author: true,
    media: true,
    replyTo: {
        with: {
            author: true,
            media: true,
        },
    },
} as const;

const postDetailRelations = {
    ...embeddedPostRelations,
    repostOf: {
        with: embeddedPostRelations,
    },
} as const;

type SwarmDetailPostInput = {
    id: string;
    originalPostId?: string;
    nodeDomain?: string | null;
    content: string;
    createdAt: string;
    likesCount?: number;
    repostsCount?: number;
    repliesCount?: number;
    likeCount?: number;
    repostCount?: number;
    replyCount?: number;
    repostOfId?: string | null;
    repostOf?: SwarmDetailPostInput | null;
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
    author?: {
        handle: string;
        displayName?: string | null;
        avatarUrl?: string | null;
        isNsfw?: boolean;
        nodeIsNsfw?: boolean;
    } | null;
    isNsfw?: boolean;
    nodeIsNsfw?: boolean;
    media?: Array<{
        id?: string;
        url: string;
        altText?: string | null;
        mimeType?: string | null;
    }>;
    linkPreviewUrl?: string | null;
    linkPreviewTitle?: string | null;
    linkPreviewDescription?: string | null;
    linkPreviewImage?: string | null;
    linkPreviewType?: 'card' | 'image' | 'gallery' | 'video' | null;
    linkPreviewVideoUrl?: string | null;
    linkPreviewMedia?: unknown;
};

function mapSwarmDetailPost(post: SwarmDetailPostInput, fallbackDomain: string): Record<string, unknown> {
    const effectiveDomain = post.nodeDomain || fallbackDomain;
    const rawId = post.originalPostId || post.id;

    return {
        id: post.id?.startsWith('swarm:') ? post.id : `swarm:${effectiveDomain}:${rawId}`,
        originalPostId: rawId,
        content: post.content,
        createdAt: post.createdAt,
        likesCount: post.likesCount ?? post.likeCount ?? 0,
        repostsCount: post.repostsCount ?? post.repostCount ?? 0,
        repliesCount: post.repliesCount ?? post.replyCount ?? 0,
        isSwarm: true,
        nodeDomain: effectiveDomain,
        isNsfw: post.isNsfw,
        nodeIsNsfw: post.nodeIsNsfw,
        repostOfId: post.repostOf
            ? (post.repostOf.id?.startsWith('swarm:')
                ? post.repostOf.id
                : `swarm:${post.repostOf.nodeDomain || effectiveDomain}:${post.repostOf.originalPostId || post.repostOf.id}`)
            : (post.repostOfId ? `swarm:${effectiveDomain}:${post.repostOfId}` : null),
        repostOf: post.repostOf ? mapSwarmDetailPost(post.repostOf, post.repostOf.nodeDomain || effectiveDomain) : null,
        repostedBy: post.repostedBy?.map((reposter) => {
            const reposterDomain = reposter.nodeDomain || effectiveDomain;
            const address = resolveAccountAddress(reposter.handle, reposterDomain);
            return {
                ...reposter,
                id: reposter.id?.startsWith('swarm:')
                    ? reposter.id
                    : `swarm:${reposterDomain}:${address?.username || reposter.handle}`,
                handle: address?.canonical || reposter.handle,
                nodeDomain: reposterDomain,
                isSwarm: true,
                isRemote: true,
            };
        }),
        repostedByCount: post.repostedByCount,
        author: post.author ? {
            id: `swarm:${effectiveDomain}:${resolveAccountAddress(post.author.handle, effectiveDomain)?.username || post.author.handle}`,
            handle: resolveAccountAddress(post.author.handle, effectiveDomain)?.canonical || post.author.handle,
            displayName: post.author.displayName,
            avatarUrl: post.author.avatarUrl,
            isSwarm: true,
            nodeDomain: effectiveDomain,
            isNsfw: post.author.isNsfw,
            nodeIsNsfw: post.author.nodeIsNsfw ?? post.nodeIsNsfw,
        } : null,
        media: post.media?.map((m, idx) => ({
            id: m.id || `swarm:${effectiveDomain}:${rawId}:media:${idx}`,
            url: m.url,
            altText: m.altText || null,
            mimeType: m.mimeType || null,
        })) || [],
        linkPreviewUrl: post.linkPreviewUrl,
        linkPreviewTitle: post.linkPreviewTitle,
        linkPreviewDescription: post.linkPreviewDescription,
        linkPreviewImage: post.linkPreviewImage,
        linkPreviewType: post.linkPreviewType || null,
        linkPreviewVideoUrl: post.linkPreviewVideoUrl || null,
        linkPreviewMedia: post.linkPreviewMedia || null,
    };
}

function postRecordIsSensitive(
    value: Record<string, unknown>,
    localNodeDomain: string,
    localNodeIsNsfw: boolean,
): boolean {
    const author = value.author && typeof value.author === 'object'
        ? value.author as Record<string, unknown>
        : null;
    const nodeDomain = typeof value.nodeDomain === 'string' ? value.nodeDomain : null;
    const isRemote = value.isSwarm === true
        || value.isRemote === true
        || author?.isRemote === true
        || Boolean(nodeDomain && nodeDomain !== localNodeDomain);
    const sensitive = isPostSensitive({
        postIsNsfw: typeof value.isNsfw === 'boolean' ? value.isNsfw : undefined,
        authorIsNsfw: typeof author?.isNsfw === 'boolean' ? author.isNsfw : undefined,
        nodeIsNsfw: typeof value.nodeIsNsfw === 'boolean'
            ? value.nodeIsNsfw
            : typeof author?.nodeIsNsfw === 'boolean'
                ? author.nodeIsNsfw
                : isRemote ? undefined : localNodeIsNsfw,
        isRemote,
    });
    if (sensitive) return true;

    const repostOf = value.repostOf;
    return Boolean(repostOf && typeof repostOf === 'object'
        && postRecordIsSensitive(
            repostOf as Record<string, unknown>,
            localNodeDomain,
            localNodeIsNsfw,
        ));
}

export async function GET(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const { id: rawId } = await params;
        // Decode URL-encoded characters (e.g., %3A -> :)
        const nodeDomain = requireCanonicalAccountHomeDomain(
            process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:43821',
        );
        const id = normalizeSameNodePostId(decodeURIComponent(rawId), nodeDomain);

        // Adult-only nodes are never browsable anonymously, including direct
        // post URLs that bypass the node feed and profile pages.
        const viewerAccess = await getSensitiveContentViewerAccess();
        const revealSensitive = new URL(request.url).searchParams.get('revealSensitive') === '1';
        const canRevealRequestedSensitivePost = Boolean(
            viewerAccess.viewer
            && revealSensitive
            && viewerAccess.viewer.ageVerifiedAt,
        );
        if (viewerAccess.localNodeIsNsfw && !viewerAccess.viewer) {
            return NextResponse.json(
                { error: SENSITIVE_PROFILE_MESSAGE, restricted: true },
                { status: 403 },
            );
        }

        let mainPost: Record<string, unknown> | null = null;
        let replyPosts: Array<Record<string, unknown>> = [];

        // Handle swarm post IDs (format: swarm:domain:uuid)
        if (id.startsWith('swarm:')) {
            const parsedSwarmId = parseSwarmPostId(id);
            if (!parsedSwarmId) {
                return NextResponse.json({ error: 'Invalid swarm post ID' }, { status: 400 });
            }
            const { domain: originDomain, originalPostId } = parsedSwarmId;

                // Fetch from origin node in real-time
                try {
                    const protocol = originDomain.includes('localhost') ? 'http' : 'https';
                    const [postResult, repliesResult] = await Promise.allSettled([
                        signedFederationRead(`${protocol}://${originDomain}/api/swarm/posts/${originalPostId}`, {
                            headers: { 'Accept': 'application/json' },
                            timeoutMs: 8_000,
                            maxResponseBytes: 1024 * 1024,
                        }),
                        signedFederationRead(`${protocol}://${originDomain}/api/swarm/replies?postId=${encodeURIComponent(originalPostId)}`, {
                            headers: { 'Accept': 'application/json' },
                            timeoutMs: 8_000,
                            maxResponseBytes: 1024 * 1024,
                        }),
                    ]);

                    if (postResult.status === 'rejected') throw postResult.reason;
                    const res = postResult.value;

                    if (res.status >= 200 && res.status < 300) {
                        const validatedDetail = parseRemotePostDetailResponse(
                            res.json(),
                            originDomain,
                            originalPostId,
                        );
                        const data = validatedDetail as unknown as {
                            post: SwarmDetailPostInput;
                            replies: SwarmDetailPostInput[];
                        };
                        const knownAdultNode = await getKnownSwarmNodeNsfw(originDomain) === true;
                        const classifyOriginPost = (post: SwarmDetailPostInput): SwarmDetailPostInput => knownAdultNode
                            ? {
                                ...post,
                                isNsfw: true,
                                nodeIsNsfw: true,
                                author: post.author ? {
                                    ...post.author,
                                    isNsfw: true,
                                    nodeIsNsfw: true,
                                } : post.author,
                                repostOf: post.repostOf ? classifyOriginPost(post.repostOf) : post.repostOf,
                            }
                            : post;
                        const originPost = classifyOriginPost(data.post);

                        mainPost = mapSwarmDetailPost({
                            ...originPost,
                            id,
                            originalPostId,
                            nodeDomain: originDomain,
                        }, originDomain);

                        // The post endpoint intentionally exports only replies authored on the
                        // origin node. The dedicated thread endpoint includes replies delivered
                        // from other signed peers, so prefer it when the origin supports it.
                        let originReplies = data.replies || [];
                        if (repliesResult.status === 'fulfilled'
                            && repliesResult.value.status >= 200
                            && repliesResult.value.status < 300) {
                            try {
                                // A hostile relay can name arbitrary provenance
                                // source domains. Already-pinned node identities
                                // are cheap; cap first-contact DNS/key discovery
                                // per thread load to prevent callback amplification.
                                const unpinnedProvenanceSources = new Set<string>();
                                originReplies = await parseRemoteRepliesResponse(
                                    repliesResult.value.json(),
                                    originDomain,
                                    originalPostId,
                                    {
                                        verifyNodeProof: async (payload, signature, senderDomain) => {
                                            const pinned = await getPinnedSwarmNodePublicKey(senderDomain);
                                            if (!pinned && !unpinnedProvenanceSources.has(senderDomain)) {
                                                if (unpinnedProvenanceSources.size >= 4) return false;
                                                unpinnedProvenanceSources.add(senderDomain);
                                            }
                                            return verifySwarmRequest(payload, signature, senderDomain);
                                        },
                                        verifyIdentityContinuity: async (identity) => {
                                            try {
                                                await pinVerifiedFederatedActorIdentity(identity);
                                                return true;
                                            } catch {
                                                return false;
                                            }
                                        },
                                    },
                                ) as unknown as SwarmDetailPostInput[];
                            } catch (error) {
                                console.warn(`[Posts] Ignoring invalid thread response from ${originDomain}`, error);
                            }
                        }

                        replyPosts = originReplies.map((reply) => mapSwarmDetailPost({
                            ...classifyOriginPost(reply),
                            nodeDomain: reply.nodeDomain || originDomain,
                        }, reply.nodeDomain || originDomain));

                        mainPost.repliesCount = replyPosts.length;

                        // Check if current user has liked this post
                        try {
                            const { requireAuth } = await import('@/lib/auth');
                            const { getViewerSwarmRepostedPostIds } = await import('@/lib/swarm/reposts');
                            const viewer = await requireAuth();

                            const likeCheckUrl = new URL(
                                `/api/swarm/posts/${encodeURIComponent(originalPostId)}/likes`,
                                `${protocol}://${originDomain}`,
                            );
                            likeCheckUrl.searchParams.set('checkHandle', viewer.handle);
                            likeCheckUrl.searchParams.set('checkDomain', nodeDomain);
                            const likeCheckRes = await signedFederationRead(likeCheckUrl.toString(), {
                                timeoutMs: 3_000,
                                maxResponseBytes: 32 * 1024,
                            });

                            if (likeCheckRes.status >= 200 && likeCheckRes.status < 300) {
                                const likeData = likeCheckRes.json() as { isLiked?: boolean };
                                mainPost.isLiked = likeData.isLiked;
                            }

                            const repostedIds = await getViewerSwarmRepostedPostIds([
                                {
                                    id,
                                    nodeDomain: originDomain,
                                    originalPostId,
                                },
                            ], viewer.id);
                            mainPost.isReposted = repostedIds.has(id);
                        } catch {
                            // Not logged in or timeout
                        }

                        if (!viewerAccess.viewer) {
                            if (postRecordIsSensitive(mainPost, nodeDomain, viewerAccess.localNodeIsNsfw)) {
                                return NextResponse.json(
                                    { error: SENSITIVE_PROFILE_MESSAGE, restricted: true },
                                    { status: 403 },
                                );
                            }
                            replyPosts = replyPosts.filter((reply) => (
                                !postRecordIsSensitive(reply, nodeDomain, viewerAccess.localNodeIsNsfw)
                            ));
                        }

                        return NextResponse.json({
                            post: redactSensitivePostForViewer(mainPost, {
                                canViewSensitive: viewerAccess.canViewSensitive,
                                localNodeDomain: nodeDomain,
                                localNodeIsNsfw: viewerAccess.localNodeIsNsfw,
                                revealSensitiveRoot: canRevealRequestedSensitivePost,
                            }),
                            replies: replyPosts.map((reply) => redactSensitivePostForViewer(reply, {
                                canViewSensitive: viewerAccess.canViewSensitive,
                                localNodeDomain: nodeDomain,
                                localNodeIsNsfw: viewerAccess.localNodeIsNsfw,
                            })),
                        });
                    }
                } catch (err) {
                    console.error(`[Swarm] Failed to fetch post from ${originDomain}:`, err);
                }

                return NextResponse.json({ error: 'Post not found' }, { status: 404 });
        }

        const post = await db.query.posts.findFirst({
            where: { id: id },
            with: postDetailRelations,
        });

        if (post) {
            const replies = await db.query.posts.findMany({
                where: { AND: [{ replyToId: id }, { isRemoved: false }] },
                with: postDetailRelations,
                orderBy: (posts, { desc }) => [desc(posts.createdAt)],
            });
            const remoteRepostRows = await db.query.remoteReposts.findMany({
                where: { postId: { in: [post.id, ...replies.map((reply) => reply.id)] } },
                orderBy: (remoteReposts, { desc }) => [desc(remoteReposts.createdAt)],
            });
            const [summarizedPost, ...summarizedReplies] = attachRemoteRepostSummaries(
                [post, ...replies],
                remoteRepostRows,
            );

            mainPost = {
                ...summarizedPost,
                repliesCount: replies.length,
            };

            let allPostIds = [post.id, ...replies.map(r => r.id)];

            try {
                const { requireAuth } = await import('@/lib/auth');
                const viewer = await requireAuth();
                allPostIds = [post.id, ...replies.map(r => r.id)];

                if (allPostIds.length > 0) {
                    const viewerLikes = await db.query.likes.findMany({
                        where: { AND: [{ userId: viewer.id }, { postId: { in: allPostIds } }] },
                    });
                    const likedPostIds = new Set(viewerLikes.map(l => l.postId));

                    const viewerReposts = await db.query.posts.findMany({
                        where: { AND: [{ userId: viewer.id }, { repostOfId: { in: allPostIds } }, { isRemoved: false }] },
                    });
                    const repostedPostIds = new Set(viewerReposts.map(r => r.repostOfId));

                    mainPost = {
                        ...mainPost,
                        isLiked: likedPostIds.has(post.id),
                        isReposted: repostedPostIds.has(post.id),
                    };

                    replyPosts = summarizedReplies.map(r => ({
                        ...r,
                        isLiked: likedPostIds.has(r.id),
                        isReposted: repostedPostIds.has(r.id),
                    }));
                }
            } catch {
            }
        } else {
            const cached = await db.query.remotePosts.findFirst({
                where: { apId: id },
            });

            if (cached) {
                mainPost = {
                    id: cached.id,
                    content: cached.content,
                    createdAt: cached.publishedAt.toISOString(),
                    likesCount: 0,
                    repostsCount: 0,
                    repliesCount: 0,
                    author: {
                        id: cached.authorHandle,
                        handle: cached.authorHandle,
                        displayName: cached.authorDisplayName || cached.authorHandle,
                        avatarUrl: cached.authorAvatarUrl,
                        bio: null,
                        isRemote: true,
                    },
                    media: cached.mediaJson ? JSON.parse(cached.mediaJson) : null,
                    linkPreviewUrl: cached.linkPreviewUrl,
                    linkPreviewTitle: cached.linkPreviewTitle,
                    linkPreviewDescription: cached.linkPreviewDescription,
                    linkPreviewImage: cached.linkPreviewImage,
                    linkPreviewType: cached.linkPreviewType,
                    linkPreviewVideoUrl: cached.linkPreviewVideoUrl,
                    linkPreviewMedia: parseLinkPreviewMediaJson(cached.linkPreviewMediaJson) || null,
                    isLiked: false,
                    isReposted: false,
                };
            } else {
                // Remote posts are no longer supported outside of swarm
                return NextResponse.json({ error: 'Post not found' }, { status: 404 });
            }
        }

        if (!mainPost) {
            return NextResponse.json({ error: 'Post not found' }, { status: 404 });
        }

        if (!viewerAccess.viewer) {
            if (postRecordIsSensitive(mainPost, nodeDomain, viewerAccess.localNodeIsNsfw)) {
                return NextResponse.json(
                    { error: SENSITIVE_PROFILE_MESSAGE, restricted: true },
                    { status: 403 },
                );
            }
            replyPosts = replyPosts.filter((reply) => (
                !postRecordIsSensitive(reply, nodeDomain, viewerAccess.localNodeIsNsfw)
            ));
        }

        return NextResponse.json({
            post: redactSensitivePostForViewer(mainPost, {
                canViewSensitive: viewerAccess.canViewSensitive,
                localNodeDomain: nodeDomain,
                localNodeIsNsfw: viewerAccess.localNodeIsNsfw,
                revealSensitiveRoot: canRevealRequestedSensitivePost,
            }),
            replies: replyPosts.map((reply) => redactSensitivePostForViewer(reply, {
                canViewSensitive: viewerAccess.canViewSensitive,
                localNodeDomain: nodeDomain,
                localNodeIsNsfw: viewerAccess.localNodeIsNsfw,
            })),
        });
    } catch (error) {
        console.error('Get post detail error:', error);
        return NextResponse.json(
            { error: 'Failed to get post detail' },
            { status: 500 }
        );
    }
}

export async function DELETE(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const signedAction = signedUserActionSchema.parse(await request.json());
        const user = await requireSignedAction(signedAction, 'delete');
        const nodeDomain = requireCanonicalAccountHomeDomain(
            process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:43821',
        );
        const { id: rawId } = await params;
        const decodedId = decodeURIComponent(rawId);
        const deleteData = z.strictObject({ postId: z.string().min(1).max(512) })
            .parse(signedAction.data);
        if (deleteData.postId !== decodedId) {
            return NextResponse.json({ error: 'Post ID mismatch' }, { status: 403 });
        }
        const id = normalizeSameNodePostId(decodedId, nodeDomain);

        // Handle swarm post IDs (format: swarm:domain:uuid)
        if (id.startsWith('swarm:')) {
            const parsedSwarmId = parseSwarmPostId(id);
            if (!parsedSwarmId) {
                return NextResponse.json({ error: 'Invalid swarm post ID' }, { status: 400 });
            }
            const { domain: originDomain, originalPostId } = parsedSwarmId;

                // We need to fetch the post from the remote node to check if the current user is the author
                // The remote node should have the post with proper attribution
                try {
                    const protocol = originDomain.includes('localhost') ? 'http' : 'https';
                    const res = await signedFederationRead(`${protocol}://${originDomain}/api/swarm/posts/${originalPostId}`, {
                        headers: { 'Accept': 'application/json' },
                        timeoutMs: 5_000,
                        maxResponseBytes: 1024 * 1024,
                    });

                    if (res.status >= 200 && res.status < 300) {
                        const data = res.json() as {
                            post?: {
                                apId?: string | null;
                                author?: { handle?: string };
                            };
                        };
                        const remotePost = data.post;
                        if (!remotePost) {
                            return NextResponse.json({ error: 'Post not found' }, { status: 404 });
                        }

                        // Check authorship
                        // Format: handle or handle@domain
                        // If the user authored it, the remote post author handle should match current user handle
                        // AND the remote post author node domain should be THIS node

                        // The remote node returns author as: 
                        // { handle: "user", displayName: "...", nodeDomain: "our-domain" } 
                        // OR if it's a "local" user on that node (which shouldn't correspond to us unless we possess that account)

                        // In the swarm reply scenario, the remote node stores our user as a "remote user"
                        // Its logic: handle = "user@our-domain"

                        // So we check if remotePost.author.handle starts with user.handle
                        // AND (remotePost.author.handle ends with @nodeDomain OR remotePost.nodeDomain == nodeDomain?)

                        const normalizedLocalDomain = normalizeNodeDomain(nodeDomain);
                        const remoteAuthorAddress = remotePost.author?.handle
                            ? resolveAccountAddress(remotePost.author.handle, normalizedLocalDomain)
                            : null;
                        const isAuthor = remoteAuthorAddress?.canonical === user.handle;

                        if (!isAuthor) {
                            return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
                        }

                        // It is our post (or reply). We can delete it.
                        // We need the original ID that WE sent when creating it.
                        // Ideally, the remote node preserves the apId we sent, which contains our original ID.
                        // But the remote node endpoint returns 'apId', let's use that if available.

                        // If we are deleting a reply we sent
                        // The remote node has it stored. 
                        // We need to send DELETE /api/swarm/replies with { replyId: <OUR_ID> }
                        // The remote node checks `swarm:ourDomain:<OUR_ID>`

                        // We need to extract <OUR_ID> from the remote post's apId
                        // remotePost.apId should be `swarm:ourDomain:ourId`

                        const deliveredReplyId = remotePost.apId
                            ? parseSwarmPostId(remotePost.apId)
                            : null;
                        if (!deliveredReplyId || deliveredReplyId.domain !== normalizedLocalDomain) {
                            return NextResponse.json(
                                { error: 'Remote reply ownership could not be verified' },
                                { status: 409 },
                            );
                        }

                        // Propagate deletion
                        const deleteRes = await sendSignedSwarmReplyDeletion(originDomain, {
                            replyId: deliveredReplyId.originalPostId,
                            nodeDomain: normalizedLocalDomain,
                            authorHandle: user.handle,
                        }, signedAction);

                        if (deleteRes.status >= 200 && deleteRes.status < 300) {
                            return NextResponse.json({ success: true });
                        } else {
                            return NextResponse.json({ error: 'Failed to delete on remote node' }, { status: deleteRes.status });
                        }
                    } else {
                        return NextResponse.json({ error: 'Remote post not found for verification' }, { status: 404 });
                    }
                } catch (err) {
                    console.error('[Swarm] Error deleting remote post:', err);
                    return NextResponse.json({ error: 'Failed to communicate with remote node' }, { status: 502 });
                }
        }

        const post = await db.query.posts.findFirst({ where: { id } });

        if (!post) {
            return NextResponse.json({ error: 'Post not found' }, { status: 404 });
        }

        // Allow deletion if the user owns the post or its parent post.
        const isPostOwner = post.userId === user.id;

        // Check if user owns the parent post (for deleting replies on their posts)
        let isParentPostOwner = false;
        if (post.replyToId) {
            const parentPost = await db.query.posts.findFirst({
                where: { id: post.replyToId },
            });
            if (parentPost && parentPost.userId === user.id) {
                isParentPostOwner = true;
            }
        }

        if (!isPostOwner && !isParentPostOwner) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
        }

        // If this is a reply to a swarm post, notify the origin before making
        // the local half of the deletion irreversible.
        if (post.swarmReplyToId) {
            const parsedParentId = parseSwarmPostId(post.swarmReplyToId);
            if (parsedParentId) {
                const originDomain = parsedParentId.domain;

                // Propagate deletion to origin node
                try {
                    const res = await sendSignedSwarmReplyDeletion(originDomain, {
                        replyId: post.id,
                        nodeDomain: normalizeNodeDomain(nodeDomain),
                        authorHandle: user.handle,
                    }, signedAction);

                    if (res.status >= 200 && res.status < 300) {
                        console.log(`[Swarm] Deletion propagated to ${originDomain}`);
                    } else {
                        return NextResponse.json(
                            { error: 'The reply could not be removed from its origin node. Nothing was deleted locally.' },
                            { status: 502 },
                        );
                    }
                } catch (err) {
                    console.error('[Swarm] Error propagating deletion:', err);
                    return NextResponse.json(
                        { error: 'The reply origin is unavailable. Nothing was deleted locally.' },
                        { status: 502 },
                    );
                }
            }
        }

        // The local post, parent counter, and author counter are one mutation.
        // A process crash cannot leave a deleted row with stale counters.
        await db.transaction(async (tx) => {
            if (post.replyToId) {
                await tx.update(posts)
                    .set({ repliesCount: sql`max(0, ${posts.repliesCount} - 1)` })
                    .where(eq(posts.id, post.replyToId));
            }
            await tx.delete(posts).where(eq(posts.id, id));
            await tx.update(users)
                .set({ postsCount: sql`max(0, ${users.postsCount} - 1)` })
                .where(eq(users.id, post.userId));
        });

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Delete post error:', error);
        if (error instanceof z.ZodError) {
            return NextResponse.json({ error: 'Invalid signed deletion' }, { status: 400 });
        }
        return NextResponse.json(
            { error: 'Failed to delete post' },
            { status: 500 }
        );
    }
}
