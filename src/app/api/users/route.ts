import { NextRequest, NextResponse } from 'next/server';
import { db, follows, users } from '@/db';
import { and, desc, eq, inArray, lt, or } from 'drizzle-orm';
import { getSensitiveContentViewerAccess } from '@/lib/nsfw/viewer-access';
import { redactSensitiveUserSummary } from '@/lib/nsfw/content-visibility';
import { parseBoundedInteger } from '@/lib/http/query';
import { stuffboxBadgeFromStoredUser } from '@/lib/stuffbox/badge';

export async function GET(request: NextRequest) {
    try {
        if (!db) {
            return NextResponse.json({ users: [] });
        }

        const searchParams = request.nextUrl.searchParams;
        const limit = parseBoundedInteger(searchParams.get('limit'), {
            defaultValue: 20,
            min: 1,
            max: 50,
        });
        const cursor = searchParams.get('cursor');
        const { viewer, localNodeIsNsfw, canViewSensitive } = await getSensitiveContentViewerAccess();
        if (localNodeIsNsfw && !viewer) {
            return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
        }

        const cursorUser = cursor
            ? await db.query.users.findFirst({ where: { id: cursor } })
            : null;
        if (cursor && !cursorUser) {
            return NextResponse.json({ error: 'Invalid cursor' }, { status: 400 });
        }
        const cursorCondition = cursorUser
            ? or(
                lt(users.createdAt, cursorUser.createdAt),
                and(eq(users.createdAt, cursorUser.createdAt), lt(users.id, cursorUser.id)),
            )
            : undefined;
        const rows = await db
            .select({
                id: users.id,
                handle: users.handle,
                displayName: users.displayName,
                bio: users.bio,
                avatarUrl: users.avatarUrl,
                createdAt: users.createdAt,
                isNsfw: users.isNsfw,
                stuffboxBadgeProof: users.stuffboxBadgeProof,
                stuffboxBadgeLevel: users.stuffboxBadgeLevel,
                stuffboxBadgePlan: users.stuffboxBadgePlan,
                stuffboxBadgeIssuer: users.stuffboxBadgeIssuer,
                stuffboxBadgeExpiresAt: users.stuffboxBadgeExpiresAt,
            })
            .from(users)
            .where(and(
                eq(users.isSuspended, false),
                eq(users.isLocalAccount, true),
                cursorCondition,
            ))
            .orderBy(desc(users.createdAt), desc(users.id))
            .limit(limit + 1);
        const hasMore = rows.length > limit;
        const userList = rows.slice(0, limit);

        const followedUserIds = new Set<string>();
        if (viewer && userList.length > 0) {
            const followRows = await db
                .select({ followingId: follows.followingId })
                .from(follows)
                .where(and(
                    eq(follows.followerId, viewer.id),
                    inArray(follows.followingId, userList.map((listedUser) => listedUser.id)),
                ));
            followRows.forEach((follow) => followedUserIds.add(follow.followingId));
        }

        return NextResponse.json({
            users: userList.map((listedUser) => redactSensitiveUserSummary({
                ...listedUser,
                isRemote: false,
                nodeIsNsfw: localNodeIsNsfw,
                isFollowing: followedUserIds.has(listedUser.id),
                stuffboxBadge: stuffboxBadgeFromStoredUser(listedUser),
            }, canViewSensitive)),
            nextCursor: hasMore ? userList.at(-1)?.id || null : null,
        });
    } catch (error) {
        console.error('List users error:', error);
        return NextResponse.json({ users: [] });
    }
}
