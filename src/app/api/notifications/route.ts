import { NextResponse } from 'next/server';
import { db, notifications } from '@/db';
import { requireAuth } from '@/lib/auth';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { requireLocalNodeNsfwClassification } from '@/lib/node/local-node';
import { shouldIncludeNsfwFeed } from '@/lib/nsfw/feed-access';
import { isPostSensitive } from '@/lib/nsfw/content-visibility';
import { fetchSwarmUserProfile } from '@/lib/swarm/interactions';

const markSchema = z.object({
    ids: z.array(z.string().uuid()).optional(),
    all: z.boolean().optional(),
});

/**
 * Fetch fresh profile data for a remote actor
 */
async function fetchRemoteProfile(handle: string, nodeDomain: string): Promise<{
    displayName: string | null;
    avatarUrl: string | null;
    isNsfw?: boolean;
    nodeIsNsfw?: boolean;
} | null> {
    try {
        const data = await fetchSwarmUserProfile(handle, nodeDomain, 0);
        if (!data) return null;
        return {
            displayName: data.profile.displayName || null,
            avatarUrl: data.profile.avatarUrl || null,
            isNsfw: typeof data.profile.isNsfw === 'boolean'
                ? data.profile.isNsfw
                : undefined,
            nodeIsNsfw: typeof data.profile.nodeIsNsfw === 'boolean'
                ? data.profile.nodeIsNsfw
                : undefined,
        };
    } catch {
        return null;
    }
}

export async function GET(request: Request) {
    try {
        const user = await requireAuth();

        if (!db) {
            return NextResponse.json({ notifications: [] });
        }

        const { searchParams } = new URL(request.url);
        const limit = Math.min(parseInt(searchParams.get('limit') || '30'), 50);
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

        // Always classify remote actors. A stored avatar without sensitivity
        // metadata is not safe enough to display.
        const remoteToFetch = new Map<string, { handle: string; nodeDomain: string }>();
        for (const row of rows) {
            if (row.actorNodeDomain) {
                const key = `${row.actorHandle}@${row.actorNodeDomain}`;
                if (!remoteToFetch.has(key)) {
                    remoteToFetch.set(key, {
                        handle: row.actorHandle.split('@')[0], // Get just the username part
                        nodeDomain: row.actorNodeDomain
                    });
                }
            }
        }

        // Fetch fresh profile data in parallel
        const freshProfiles = new Map<string, {
            displayName: string | null;
            avatarUrl: string | null;
            isNsfw?: boolean;
            nodeIsNsfw?: boolean;
        }>();
        if (remoteToFetch.size > 0) {
            const fetchPromises = Array.from(remoteToFetch.entries()).map(async ([key, { handle, nodeDomain }]) => {
                const profile = await fetchRemoteProfile(handle, nodeDomain);
                if (profile) {
                    freshProfiles.set(key, profile);
                }
            });
            await Promise.all(fetchPromises);
        }

        const localActorIds = Array.from(new Set(
            rows
                .filter((row) => !row.actorNodeDomain && row.actorId)
                .map((row) => row.actorId as string),
        ));
        const localActors = localActorIds.length > 0
            ? await db.query.users.findMany({ where: { id: { in: localActorIds } } })
            : [];
        const localActorMap = new Map(localActors.map((actor) => [actor.id, actor]));

        const payload = rows.map((row) => {
            const key = row.actorNodeDomain ? `${row.actorHandle}@${row.actorNodeDomain}` : null;
            const freshProfile = key ? freshProfiles.get(key) : null;
            const localActor = row.actorId ? localActorMap.get(row.actorId) : null;
            const remotePostReference = row.remotePostId && row.remotePostDomain
                ? `swarm:${row.remotePostDomain}:${row.remotePostId}`
                : null;
            const remotePostIsSensitive = remotePostReference
                ? isPostSensitive({
                    postIsNsfw: undefined,
                    authorIsNsfw: freshProfile?.isNsfw,
                    nodeIsNsfw: freshProfile?.nodeIsNsfw,
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
            const actorIsSensitive = row.actorNodeDomain
                ? isPostSensitive({
                    postIsNsfw: false,
                    authorIsNsfw: freshProfile?.isNsfw,
                    nodeIsNsfw: freshProfile?.nodeIsNsfw,
                    isRemote: true,
                })
                : localActor
                    ? localActor.isNsfw || localNodeIsNsfw
                    : true;
            const actorMediaRestricted = !canViewSensitive && actorIsSensitive;

            return {
                id: row.id,
                type: row.type,
                createdAt: row.createdAt,
                readAt: row.readAt,
                actor: {
                    handle: row.actorNodeDomain
                        ? `${row.actorHandle}@${row.actorNodeDomain}`
                        : row.actorHandle,
                    displayName: freshProfile?.displayName || row.actorDisplayName,
                    avatarUrl: actorMediaRestricted
                        ? null
                        : freshProfile
                            ? freshProfile.avatarUrl
                            : row.actorAvatarUrl,
                    nodeDomain: row.actorNodeDomain,
                    isNsfw: row.actorNodeDomain
                        ? freshProfile?.isNsfw
                        : localActor?.isNsfw ?? true,
                    nodeIsNsfw: row.actorNodeDomain
                        ? freshProfile?.nodeIsNsfw
                        : localNodeIsNsfw,
                },
                post: row.postId || remotePostReference ? {
                    id: row.postId || remotePostReference!,
                    content: postRestricted ? null : row.post?.content || row.postContent,
                    authorHandle: row.post?.author?.handle || (row.actorNodeDomain
                        ? `${row.actorHandle}@${row.actorNodeDomain}`
                        : row.actorHandle),
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
