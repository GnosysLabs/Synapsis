import { NextRequest, NextResponse } from 'next/server';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';

import { db, posts, users } from '@/db';
import { authorizeFederationRead, federationReadFailureResponse } from '@/lib/swarm/signed-read';

const postIdSchema = z.string().uuid();

/** Bounded, content-free upgrade reconciliation for pre-tombstone snapshots. */
export async function GET(request: NextRequest) {
  const readAuthorization = await authorizeFederationRead(request);
  if (!readAuthorization.ok) return federationReadFailureResponse(readAuthorization);

  const candidates = Array.from(new Set(
    (new URL(request.url).searchParams.get('ids') || '').split(',').filter(Boolean),
  ));
  if (candidates.length === 0 || candidates.length > 50) {
    return NextResponse.json({ error: 'Supply between 1 and 50 post IDs' }, { status: 400 });
  }
  const parsed = z.array(postIdSchema).safeParse(candidates);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid post ID' }, { status: 400 });
  }

  const available = await db.select({ id: posts.id })
    .from(posts)
    .innerJoin(users, eq(users.id, posts.userId))
    .where(and(
      inArray(posts.id, parsed.data),
      eq(posts.isRemoved, false),
      isNull(posts.replyToId),
      isNull(posts.swarmReplyToId),
      eq(users.isLocalAccount, true),
      eq(users.isSuspended, false),
    ));

  return NextResponse.json({
    availablePostIds: available.map((row) => row.id),
  });
}
