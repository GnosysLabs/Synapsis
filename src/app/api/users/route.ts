import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { users } from '@/db';
import { desc, sql } from 'drizzle-orm';

export async function GET(request: NextRequest) {
    try {
        if (!db) {
            return NextResponse.json({ users: [] });
        }

        const searchParams = request.nextUrl.searchParams;
        const limit = Math.min(parseInt(searchParams.get('limit') || '20'), 50);

        const userList = await db
            .select({
                id: users.id,
                handle: users.handle,
                displayName: users.displayName,
                bio: users.bio,
                avatarUrl: users.avatarUrl,
                createdAt: users.createdAt,
                isBot: users.isBot,
                isNsfw: users.isNsfw,
            })
            .from(users)
            .where(sql`${users.isSuspended} IS FALSE AND ${users.handle} NOT LIKE '%@%'`)
            .orderBy(desc(users.createdAt))
            .limit(limit);

        return NextResponse.json({ users: userList });
    } catch (error) {
        console.error('List users error:', error);
        return NextResponse.json({ users: [] });
    }
}
