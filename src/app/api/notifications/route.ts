import { NextResponse } from 'next/server';
import { db, notifications } from '@/db';
import { requireAuth } from '@/lib/auth';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { requireLocalNodeNsfwClassification } from '@/lib/node/local-node';
import { shouldIncludeNsfwFeed } from '@/lib/nsfw/feed-access';
import { isPostSensitive, isUserSensitive } from '@/lib/nsfw/content-visibility';
import { parseBoundedInteger } from '@/lib/http/query';
import {
    type AccountAddress,
    canonicalAccountHomeDomain,
    requireCanonicalAccountHomeDomain,
    resolveAccountAddress,
} from '@/lib/identity/account-address';
import { getBlockedNodeDomains } from '@/lib/swarm/node-blocklist';
import { stuffboxBadgeFromStoredUser } from '@/lib/stuffbox/badge';

const markSchema = z.object({
    ids: z.array(z.string().uuid()).optional(),
    all: z.boolean().optional(),
});

interface ActorPresentation {
    displayName: string | null;
    avatarUrl: string | null;
}

function displayNameQuality(value: string | null | undefined, address: AccountAddress | null): number {
    const displayName = value?.trim();
    if (!displayName) return 0;
    if (!address) return 2;

    const identityLikeName = displayName.replace(/^@/, '');
    return identityLikeName === address.username || identityLikeName === address.canonical
        ? 1
        : 2;
}

function mergeActorPresentation(
    current: ActorPresentation | undefined,
    candidate: ActorPresentation,
    address: AccountAddress | null,
): ActorPresentation {
    const currentDisplayName = current?.displayName?.trim() || null;
    const candidateDisplayName = candidate.displayName?.trim() || null;

    return {
        displayName: displayNameQuality(candidateDisplayName, address)
            > displayNameQuality(currentDisplayName, address)
            ? candidateDisplayName
            : currentDisplayName,
        avatarUrl: current?.avatarUrl || candidate.avatarUrl?.trim() || null,
    };
}

export async function GET(request: Request) {
    try {
        const user = await requireAuth();

        if (!db) {
            return NextResponse.json({ notifications: [] });
        }

        const { searchParams } = new URL(request.url);
        const limit = parseBoundedInteger(searchParams.get('limit'), {
            defaultValue: 30,
            min: 1,
            max: 50,
        });
        const unreadOnly = searchParams.get('unread') === 'true';
        const localNodeIsNsfw = await requireLocalNodeNsfwClassification();
        const canViewSensitive = shouldIncludeNsfwFeed({
            viewer: user,
            localNodeIsNsfw,
        });

        const queriedRows = await db.query.notifications.findMany({
            where: {
                userId: user.id,
                ...(unreadOnly ? { readAt: { isNull: true as const } } : {}),
            },
            orderBy: (notifications, { desc }) => [desc(notifications.createdAt)],
            limit,
            with: {
                post: {
                    with: {
                        author: true,
                        media: true,
                    },
                },
            },
        });
        // Cleanup is durable/retryable, but a pending quarantine must still be
        // invisible immediately at the read boundary.
        const blockedDomains = await getBlockedNodeDomains();
        const rows = queriedRows.filter((row) => (
            !blockedDomains.has(canonicalAccountHomeDomain(row.actorNodeDomain) || '')
            && !blockedDomains.has(canonicalAccountHomeDomain(row.remotePostDomain) || '')
        ));

        const actorIds = Array.from(new Set(
            rows
                .filter((row) => row.actorId)
                .map((row) => row.actorId as string),
        ));
        const actorHandles = Array.from(new Set(
            rows.flatMap((row) => {
                const address = resolveAccountAddress(row.actorHandle, row.actorNodeDomain);
                return address ? [address.canonical] : [];
            }),
        ));
        const actorDomains = Array.from(new Set(
            rows.flatMap((row) => {
                const domain = canonicalAccountHomeDomain(row.actorNodeDomain);
                return domain ? [domain] : [];
            }),
        ));
        const [actorsById, actorsByHandle, actorNodes] = await Promise.all([
            actorIds.length > 0
                ? db.query.users.findMany({ where: { id: { in: actorIds } } })
                : [],
            actorHandles.length > 0
                ? db.query.users.findMany({ where: { handle: { in: actorHandles } } })
                : [],
            actorDomains.length > 0
                ? db.query.swarmNodes.findMany({
                    where: { domain: { in: actorDomains } },
                    columns: {
                        domain: true,
                        isNsfw: true,
                        nsfwClassificationKnown: true,
                    },
                })
                : [],
        ]);
        const actorUsers = Array.from(new Map(
            [...actorsById, ...actorsByHandle].map((actor) => [actor.id, actor]),
        ).values());
        const actorMap = new Map(actorUsers.map((actor) => [actor.id, actor]));
        const actorHandleMap = new Map(actorUsers.map((actor) => [actor.handle, actor]));
        const actorNodeNsfwMap = new Map(actorNodes.flatMap((node) => {
            const domain = canonicalAccountHomeDomain(node.domain);
            if (!domain) return [];
            return [[domain, node.isNsfw
                ? true
                : node.nsfwClassificationKnown ? false : undefined] as const];
        }));
        const actorPresentations = new Map<string, ActorPresentation>();

        for (const actor of actorUsers) {
            const address = resolveAccountAddress(actor.handle, actor.homeDomain);
            if (!address) continue;
            actorPresentations.set(address.canonical, mergeActorPresentation(
                actorPresentations.get(address.canonical),
                { displayName: actor.displayName, avatarUrl: actor.avatarUrl },
                address,
            ));
        }
        // A short-lived federation regression stored username-only/no-avatar
        // snapshots. Reuse the best older snapshot for that same verified
        // canonical actor instead of rendering inconsistent rows.
        for (const row of rows) {
            const address = resolveAccountAddress(row.actorHandle, row.actorNodeDomain);
            if (!address) continue;
            actorPresentations.set(address.canonical, mergeActorPresentation(
                actorPresentations.get(address.canonical),
                { displayName: row.actorDisplayName, avatarUrl: row.actorAvatarUrl },
                address,
            ));
        }
        const localDomain = requireCanonicalAccountHomeDomain(
            process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:43821',
        );

        const payload = rows.map((row) => {
            const rowActorAddress = resolveAccountAddress(row.actorHandle, row.actorNodeDomain);
            const actorUser = (row.actorId ? actorMap.get(row.actorId) : null)
                || (rowActorAddress ? actorHandleMap.get(rowActorAddress.canonical) : null);
            const actorDomain = actorUser?.homeDomain
                || canonicalAccountHomeDomain(row.actorNodeDomain);
            const actorAddress = resolveAccountAddress(row.actorHandle, actorDomain);
            const actorHandle = actorAddress?.canonical || row.actorHandle;
            const actorUsername = actorAddress?.username || row.actorHandle;
            const actorPresentation = actorAddress
                ? actorPresentations.get(actorAddress.canonical)
                : undefined;
            const actorIsRemote = actorUser
                ? !actorUser.isLocalAccount
                : Boolean(actorDomain && actorDomain !== localDomain);
            const actorNodeIsNsfw = actorIsRemote
                ? actorNodeNsfwMap.get(actorDomain || '')
                : localNodeIsNsfw;
            const remotePostReference = row.remotePostId && row.remotePostDomain
                ? `swarm:${row.remotePostDomain}:${row.remotePostId}`
                : null;
            const remotePostIsSensitive = remotePostReference
                ? isPostSensitive({
                    postIsNsfw: undefined,
                    authorIsNsfw: undefined,
                    nodeIsNsfw: undefined,
                    isRemote: true,
                })
                : false;
            const localPostIsSensitive = row.post
                ? isPostSensitive({
                    postIsNsfw: row.post.isNsfw,
                    authorIsNsfw: row.post.author?.isNsfw,
                    nodeIsNsfw: localNodeIsNsfw,
                    isRemote: false,
                })
                : false;
            const localPostMetadataMissing = Boolean(
                row.postId && (!row.post || !row.post.author),
            );
            const postRestricted = !canViewSensitive
                && (remotePostIsSensitive || localPostIsSensitive || localPostMetadataMissing);
            const actorIsSensitive = isUserSensitive({
                accountIsNsfw: actorUser?.isNsfw,
                nodeIsNsfw: actorNodeIsNsfw,
                isRemote: actorIsRemote,
            });
            const actorMediaRestricted = !canViewSensitive && actorIsSensitive;

            return {
                id: row.id,
                type: row.type,
                createdAt: row.createdAt,
                readAt: row.readAt,
                actor: {
                    handle: actorHandle,
                    // Rendering a notification must never call the actor node.
                    // The canonical handle remains the verified identity and is
                    // rendered beside this bounded, stored presentation name.
                    displayName: actorIsRemote
                        ? actorPresentation?.displayName || actorUsername
                        : actorUser?.displayName || row.actorDisplayName,
                    avatarUrl: actorMediaRestricted
                        ? null
                        : actorIsRemote
                            ? actorPresentation?.avatarUrl || null
                            : actorUser?.avatarUrl || row.actorAvatarUrl,
                    nodeDomain: actorDomain,
                    isNsfw: actorUser?.isNsfw ?? true,
                    nodeIsNsfw: actorIsRemote
                        ? actorNodeIsNsfw ?? true
                        : localNodeIsNsfw,
                    stuffboxBadge: actorUser ? stuffboxBadgeFromStoredUser(actorUser) : null,
                },
                post: row.postId || remotePostReference ? {
                    id: row.postId || remotePostReference!,
                    content: postRestricted ? null : row.post?.content || row.postContent,
                    authorHandle: row.post?.author?.handle || actorHandle,
                    media: postRestricted ? [] : row.post?.media.map((item) => ({
                        url: item.url,
                        mimeType: item.mimeType,
                        altText: item.altText,
                    })) || [],
                    linkPreviewImage: postRestricted ? null : row.post?.linkPreviewImage || null,
                    sensitiveRestricted: postRestricted,
                } : null,
            };
        });

        return NextResponse.json({ notifications: payload }, {
            headers: { 'Cache-Control': 'private, no-store' },
        });
    } catch (error) {
        if (error instanceof Error && error.message === 'Authentication required') {
            return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
        }
        console.error('Notifications fetch error:', error);
        return NextResponse.json({ error: 'Failed to fetch notifications' }, { status: 500 });
    }
}

export async function PATCH(request: Request) {
    try {
        const user = await requireAuth();

        if (!db) {
            return NextResponse.json({ error: 'Database not available' }, { status: 503 });
        }

        const rawBody = await request.json();
        const body = rawBody?.data && typeof rawBody.data === 'object' ? rawBody.data : rawBody;
        const data = markSchema.parse(body);

        if (!data.all && (!data.ids || data.ids.length === 0)) {
            return NextResponse.json({ error: 'No notifications specified' }, { status: 400 });
        }

        const where = data.all
            ? eq(notifications.userId, user.id)
            : and(
                eq(notifications.userId, user.id),
                inArray(notifications.id, data.ids || [])
            );

        await db.update(notifications)
            .set({ readAt: new Date() })
            .where(where);

        return NextResponse.json({ success: true });
    } catch (error) {
        if (error instanceof z.ZodError) {
            return NextResponse.json({ error: 'Invalid input', details: error.issues }, { status: 400 });
        }
        if (error instanceof Error && error.message === 'Authentication required') {
            return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
        }
        console.error('Notifications update error:', error);
        return NextResponse.json({ error: 'Failed to update notifications' }, { status: 500 });
    }
}
