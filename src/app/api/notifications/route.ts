import { NextResponse } from 'next/server';
import { db, notifications } from '@/db';
import { requireAuth } from '@/lib/auth';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { requireLocalNodeNsfwClassification } from '@/lib/node/local-node';
import { shouldIncludeNsfwFeed } from '@/lib/nsfw/feed-access';
import { isPostSensitive } from '@/lib/nsfw/content-visibility';
import { parseBoundedInteger } from '@/lib/http/query';
import {
    canonicalAccountHomeDomain,
    requireCanonicalAccountHomeDomain,
} from '@/lib/identity/account-address';

const markSchema = z.object({
    ids: z.array(z.string().uuid()).optional(),
    all: z.boolean().optional(),
});

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

        const rows = await db.query.notifications.findMany({
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

        const actorIds = Array.from(new Set(
            rows
                .filter((row) => row.actorId)
                .map((row) => row.actorId as string),
        ));
        const actorUsers = actorIds.length > 0
            ? await db.query.users.findMany({ where: { id: { in: actorIds } } })
            : [];
        const actorMap = new Map(actorUsers.map((actor) => [actor.id, actor]));
        const localDomain = requireCanonicalAccountHomeDomain(
            process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:43821',
        );

        const payload = rows.map((row) => {
            const actorUser = row.actorId ? actorMap.get(row.actorId) : null;
            const actorDomain = actorUser?.homeDomain
                || canonicalAccountHomeDomain(row.actorNodeDomain);
            const actorIsRemote = actorUser
                ? !actorUser.isLocalAccount
                : Boolean(actorDomain && actorDomain !== localDomain);
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
            const actorIsSensitive = actorIsRemote
                ? isPostSensitive({
                    postIsNsfw: false,
                    authorIsNsfw: undefined,
                    nodeIsNsfw: undefined,
                    isRemote: true,
                })
                : actorUser
                    ? actorUser.isNsfw || localNodeIsNsfw
                    : true;
            const actorMediaRestricted = !canViewSensitive && actorIsSensitive;

            return {
                id: row.id,
                type: row.type,
                createdAt: row.createdAt,
                readAt: row.readAt,
                actor: {
                    handle: row.actorHandle,
                    // Rendering a notification must never call the actor node.
                    // Remote identity proofs bind the handle, not mutable
                    // profile presentation, so use DiceBear via the client.
                    displayName: actorIsRemote
                        ? row.actorHandle
                        : actorUser?.displayName || row.actorDisplayName,
                    avatarUrl: actorIsRemote || actorMediaRestricted
                        ? null
                        : actorUser?.avatarUrl || row.actorAvatarUrl,
                    nodeDomain: actorDomain,
                    isNsfw: actorIsRemote
                        ? undefined
                        : actorUser?.isNsfw ?? true,
                    nodeIsNsfw: actorIsRemote
                        ? undefined
                        : localNodeIsNsfw,
                },
                post: row.postId || remotePostReference ? {
                    id: row.postId || remotePostReference!,
                    content: postRestricted ? null : row.post?.content || row.postContent,
                    authorHandle: row.post?.author?.handle || row.actorHandle,
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

        return NextResponse.json({ notifications: payload });
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
