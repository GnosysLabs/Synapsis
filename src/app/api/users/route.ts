import { NextRequest, NextResponse } from 'next/server';
import { db, follows, users } from '@/db';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { getSensitiveContentViewerAccess } from '@/lib/nsfw/viewer-access';
import { redactSensitiveUserSummary } from '@/lib/nsfw/content-visibility';
import { parseBoundedInteger } from '@/lib/http/query';

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
        const { viewer, localNodeIsNsfw, canViewSensitive } = await getSensitiveContentViewerAccess();
        if (localNodeIsNsfw && !viewer) {
            return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
        }

        const userList = await db
            .select({
                id: users.id,
                handle: users.handle,
                displayName: users.displayName,
                bio: users.bio,
                avatarUrl: users.avatarUrl,
                createdAt: users.createdAt,
                isNsfw: users.isNsfw,
            })
            .from(users)
            .where(and(
                eq(users.isSuspended, false),
                eq(users.isLocalAccount, true),
            ))
            .orderBy(desc(users.createdAt))
            .limit(limit);

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
            }, canViewSensitive)),
        });
    } catch (error) {
        console.error('List users error:', error);
        return NextResponse.json({ users: [] });
    }
}
