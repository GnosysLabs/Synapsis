import { NextResponse } from 'next/server';
import { db, posts } from '@/db';
import { requireAdmin } from '@/lib/auth/admin';
import { desc, eq } from 'drizzle-orm';

export async function GET(request: Request) {
    try {
        await requireAdmin();

        if (!db) {
            return NextResponse.json({ error: 'Database not available' }, { status: 503 });
        }

        const { searchParams } = new URL(request.url);
        const status = searchParams.get('status') || 'active'; // active | removed | all
        const limit = Math.min(parseInt(searchParams.get('limit') || '25'), 50);

        const where = status === 'all'
            ? undefined
            : { isRemoved: status === 'removed' };

        const results = await db.query.posts.findMany({
            where,
            with: {
                author: true,
            },
            orderBy: (posts, { desc }) => [desc(posts.createdAt)],
            limit,
        });

        const sanitized = results.map((post) => {
            const author = post.author as { id: string; handle: string; displayName: string | null };
            return {
                id: post.id,
                content: post.content,
                createdAt: post.createdAt,
                isRemoved: post.isRemoved,
                removedReason: post.removedReason,
                author: {
                    id: author.id,
                    handle: author.handle,
                    displayName: author.displayName,
                },
            };
        });

        return NextResponse.json({ posts: sanitized });
    } catch (error) {
        if (error instanceof Error && error.message === 'Admin required') {
            return NextResponse.json({ error: 'Admin required' }, { status: 403 });
        }
        console.error('Admin posts error:', error);
        return NextResponse.json({ error: 'Failed to fetch posts' }, { status: 500 });
    }
}
