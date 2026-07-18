import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { users } from '@/db';
import { desc, sql } from 'drizzle-orm';
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
            .where(sql`${users.isSuspended} IS FALSE AND ${users.handle} NOT LIKE '%@%'`)
            .orderBy(desc(users.createdAt))
            .limit(limit);

        return NextResponse.json({
            users: userList.map((listedUser) => redactSensitiveUserSummary({
                ...listedUser,
                isRemote: false,
                nodeIsNsfw: localNodeIsNsfw,
            }, canViewSensitive)),
        });
    } catch (error) {
        console.error('List users error:', error);
        return NextResponse.json({ users: [] });
    }
}
