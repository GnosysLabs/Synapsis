import { NextResponse } from 'next/server';
import { db, notifications } from '@/db';
import { requireAuth } from '@/lib/auth';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';

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
} | null> {
    try {
        const protocol = nodeDomain.includes('localhost') ? 'http' : 'https';
        const res = await fetch(`${protocol}://${nodeDomain}/api/swarm/users/${handle}`, {
            headers: { 'Accept': 'application/json' },
            signal: AbortSignal.timeout(3000),
        });
        if (!res.ok) return null;
        const data = await res.json();
        return {
            displayName: data.profile?.displayName || null,
            avatarUrl: data.profile?.avatarUrl || null,
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

        const conditions = [eq(notifications.userId, user.id)];
        if (unreadOnly) {
            conditions.push(isNull(notifications.readAt));
        }

        const rows = await db.query.notifications.findMany({
            where: and(...conditions),
            orderBy: [desc(notifications.createdAt)],
            limit,
        });

        // For remote actors missing avatar, fetch fresh data
        const remoteToFetch = new Map<string, { handle: string; nodeDomain: string }>();
        for (const row of rows) {
            if (row.actorNodeDomain && !row.actorAvatarUrl) {
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
        const freshProfiles = new Map<string, { displayName: string | null; avatarUrl: string | null }>();
        if (remoteToFetch.size > 0) {
            const fetchPromises = Array.from(remoteToFetch.entries()).map(async ([key, { handle, nodeDomain }]) => {
                const profile = await fetchRemoteProfile(handle, nodeDomain);
                if (profile) {
                    freshProfiles.set(key, profile);
                }
            });
            await Promise.all(fetchPromises);
        }

        const payload = rows.map((row) => {
            const key = row.actorNodeDomain ? `${row.actorHandle}@${row.actorNodeDomain}` : null;
            const freshProfile = key ? freshProfiles.get(key) : null;

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
                    avatarUrl: freshProfile?.avatarUrl || row.actorAvatarUrl,
                    nodeDomain: row.actorNodeDomain,
                },
                target: row.targetHandle ? {
                    handle: row.targetNodeDomain
                        ? `${row.targetHandle}@${row.targetNodeDomain}`
                        : row.targetHandle,
                    displayName: row.targetDisplayName,
                    avatarUrl: row.targetAvatarUrl,
                    nodeDomain: row.targetNodeDomain,
                    isBot: row.targetIsBot,
                } : null,
                post: row.postId ? {
                    id: row.postId,
                    content: row.postContent,
                    authorHandle: row.actorHandle, // The actor is the post author for likes/reposts
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
