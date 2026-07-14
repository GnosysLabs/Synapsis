import { NextResponse } from 'next/server';
import { db, follows, users, remoteFollowers } from '@/db';
import { eq } from 'drizzle-orm';
import { hydrateSwarmUsers } from '@/lib/swarm/user-hydration';

type RouteContext = { params: Promise<{ handle: string }> };

/**
 * Fetch followers list from a remote swarm node
 */
const fetchSwarmFollowers = async (handle: string, domain: string, limit: number) => {
    try {
        const protocol = domain.includes('localhost') ? 'http' : 'https';
        const url = `${protocol}://${domain}/api/swarm/users/${handle}/followers?limit=${limit}`;
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
            const swarmData = await fetchSwarmFollowers(remoteHandle, remoteDomain, limit);
            if (swarmData?.followers) {
                // Transform to include full handles for local users on that node
                const followers = swarmData.followers.map((f: any) => ({
                    id: f.isRemote ? f.handle : `${f.handle}@${remoteDomain}`,
                    handle: f.isRemote ? f.handle : `${f.handle}@${remoteDomain}`,
                    displayName: f.displayName,
                    avatarUrl: f.avatarUrl,
                    bio: f.bio,
                    isRemote: true,
                    isBot: f.isBot,
                }));
                const hydratedFollowers = await hydrateSwarmUsers(followers);
                return NextResponse.json({ followers: hydratedFollowers, nextCursor: null });
            }
            // If swarm fetch fails, return empty
            return NextResponse.json({ followers: [], nextCursor: null });
        }

        // Return empty if no database
        if (!db) {
            return NextResponse.json({ followers: [], nextCursor: null });
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

        // Get followers
        const userFollowers = await db
            .select({
                id: follows.id,
                follower: users,
            })
            .from(follows)
            .innerJoin(users, eq(follows.followerId, users.id))
            .where(eq(follows.followingId, user.id))
            .limit(limit);

        const localFollowers = userFollowers.map(f => ({
            id: f.follower.id,
            handle: f.follower.handle,
            displayName: f.follower.displayName,
            avatarUrl: f.follower.avatarUrl,
            bio: f.follower.bio,
            isBot: f.follower.isBot,
            isRemote: false,
        }));

        // Get remote followers
        const userRemoteFollowers = await db.query.remoteFollowers.findMany({
            where: { userId: user.id },
            limit,
        });

        const remoteFollowersList = userRemoteFollowers.map(f => ({
            id: f.actorUrl,
            handle: f.handle || 'unknown',
            displayName: f.handle?.split('@')[0] || 'Unknown',
            avatarUrl: null,
            bio: null,
            isBot: false,
            isRemote: true,
        }));

        // Merge and return
        const allFollowers = [...localFollowers, ...remoteFollowersList].slice(0, limit);

        // Hydrate users with fresh data from swarm
        const hydratedFollowers = await hydrateSwarmUsers(allFollowers);

        return NextResponse.json({
            followers: hydratedFollowers,
            nextCursor: userFollowers.length === limit ? userFollowers[userFollowers.length - 1]?.id : null,
        });
    } catch (error) {
        console.error('Get followers error:', error);
        return NextResponse.json({ error: 'Failed to get followers' }, { status: 500 });
    }
}
