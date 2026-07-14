/**
 * Swarm User Following Endpoint
 * 
 * GET: Returns a user's following list for swarm requests
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, follows, users, remoteFollows } from '@/db';
import { eq } from 'drizzle-orm';

export interface SwarmFollowingUser {
  handle: string;
  displayName: string;
  avatarUrl?: string;
  bio?: string;
  isBot?: boolean;
  isRemote?: boolean;
}

type RouteContext = { params: Promise<{ handle: string }> };

/**
 * GET /api/swarm/users/[handle]/following
 * 
 * Returns a user's following list.
 * Used by other nodes to display who a remote user follows.
 */
export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const { handle } = await context.params;
    const cleanHandle = handle.toLowerCase().replace(/^@/, '');
    const { searchParams } = new URL(request.url);
    const limit = Math.min(parseInt(searchParams.get('limit') || '50'), 100);

    if (!db) {
      return NextResponse.json({ error: 'Database not available' }, { status: 503 });
    }

    const nodeDomain = process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost';

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

    const localFollowing: SwarmFollowingUser[] = userFollowing.map(f => ({
      handle: f.following.handle, // Local handle without domain
      displayName: f.following.displayName || f.following.handle,
      avatarUrl: f.following.avatarUrl || undefined,
      bio: f.following.bio || undefined,
      isBot: f.following.isBot || undefined,
      isRemote: false,
    }));

    // Get remote following
    const userRemoteFollowing = await db.query.remoteFollows.findMany({
      where: { followerId: user.id },
      limit,
    });

    const remoteFollowing: SwarmFollowingUser[] = userRemoteFollowing.map(f => ({
      handle: f.targetHandle, // Already includes @domain
      displayName: f.displayName || f.targetHandle.split('@')[0],
      avatarUrl: f.avatarUrl || undefined,
      bio: f.bio || undefined,
      isRemote: true,
    }));

    // Merge all following
    const allFollowing = [...localFollowing, ...remoteFollowing].slice(0, limit);

    return NextResponse.json({
      following: allFollowing,
      nodeDomain,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Swarm user following error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch following list' },
      { status: 500 }
    );
  }
}
