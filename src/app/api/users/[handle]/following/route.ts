import { NextResponse } from 'next/server';
import { db, follows, users, remoteFollows } from '@/db';
import { eq } from 'drizzle-orm';
import { hydrateSwarmUsers } from '@/lib/swarm/user-hydration';

type RouteContext = { params: Promise<{ handle: string }> };

/**
 * Fetch following list from a remote swarm node
 */
const fetchSwarmFollowing = async (handle: string, domain: string, limit: number) => {
    try {
        const protocol = domain.includes('localhost') ? 'http' : 'https';
        const url = `${protocol}://${domain}/api/swarm/users/${handle}/following?limit=${limit}`;
        const res = await fetch(url, {
            headers: { 'Accept': 'application/json' },
            signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) return null;
        return await res.json();
    } catch {
        return null;
    }
};

export async function GET(request: Request, context: RouteContext) {
    try {
        const { handle } = await context.params;
        const cleanHandle = handle.toLowerCase().replace(/^@/, '');
        const { searchParams } = new URL(request.url);
        const limit = Math.min(parseInt(searchParams.get('limit') || '20'), 50);

        // Check if this is a remote user
        const [remoteHandle, remoteDomain] = cleanHandle.split('@');

        if (remoteDomain) {
            // Fetch from remote swarm node
            const swarmData = await fetchSwarmFollowing(remoteHandle, remoteDomain, limit);
            if (swarmData?.following) {
                // Transform to include full handles for local users on that node
                const following = swarmData.following.map((f: any) => ({
                    id: f.isRemote ? f.handle : `${f.handle}@${remoteDomain}`,
                    handle: f.isRemote ? f.handle : `${f.handle}@${remoteDomain}`,
                    displayName: f.displayName,
                    avatarUrl: f.avatarUrl,
                    bio: f.bio,
                    isRemote: true,
                    isBot: f.isBot,
                }));
                const hydratedFollowing = await hydrateSwarmUsers(following);
                return NextResponse.json({ following: hydratedFollowing, nextCursor: null });
            }
            // If swarm fetch fails, return empty
            return NextResponse.json({ following: [], nextCursor: null });
        }

        // Return empty if no database
        if (!db) {
            return NextResponse.json({ following: [], nextCursor: null });
        }

        // Find the user
        const user = await db.query.users.findFirst({
            where: { handle: cleanHandle },
        });

        if (!user) {
            return NextResponse.json({ error: 'User not found' }, { status: 404 });
        }
        if (user.isSuspended) {
            return NextResponse.json({ error: 'User not found' }, { status: 404 });
        }

        // Get local following
        const userFollowing = await db
            .select({
                id: follows.id,
                following: users,
            })
            .from(follows)
            .innerJoin(users, eq(follows.followingId, users.id))
            .where(eq(follows.followerId, user.id))
            .limit(limit);

        const localFollowing = userFollowing.map(f => ({
            id: f.following.id,
            handle: f.following.handle,
            displayName: f.following.displayName,
            avatarUrl: f.following.avatarUrl,
            bio: f.following.bio,
            isRemote: false,
            isBot: f.following.isBot,
        }));

        // Get remote following
        const userRemoteFollowing = await db.query.remoteFollows.findMany({
            where: { followerId: user.id },
            limit,
        });

        const remoteFollowing = userRemoteFollowing.map(f => ({
            id: f.targetActorUrl,
            handle: f.targetHandle,
            displayName: f.displayName || f.targetHandle.split('@')[0], // Use stored display name or username part
            avatarUrl: f.avatarUrl,
            bio: f.bio,
            isRemote: true,
        }));

        // Merge and return
        const allFollowing = [...localFollowing, ...remoteFollowing].slice(0, limit);

        // Hydrate remote users with fresh data from swarm
        const hydratedFollowing = await hydrateSwarmUsers(allFollowing);

        return NextResponse.json({
            following: hydratedFollowing,
            nextCursor: allFollowing.length === limit ? allFollowing[allFollowing.length - 1]?.id : null,
        });
    } catch (error) {
        console.error('Get following error:', error);
        return NextResponse.json({ error: 'Failed to get following' }, { status: 500 });
    }
}
