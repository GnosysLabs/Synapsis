import { NextRequest, NextResponse } from 'next/server';
import { and, asc, eq, isNull, like, notLike, or } from 'drizzle-orm';
import { z } from 'zod';

import { db, users } from '@/db';
import { requireLocalNodeNsfwClassification } from '@/lib/node/local-node';
import { redactSensitiveUserSummary } from '@/lib/nsfw/content-visibility';
import { hasStrictLocalUserOrigin } from '@/lib/swarm/local-user-origin';
import { authorizeFederationRead, federationReadFailureResponse } from '@/lib/swarm/signed-read';

const querySchema = z.object({
  q: z.string().max(30).regex(/^[a-zA-Z0-9_ -]*$/),
  limit: z.coerce.number().int().min(1).max(12).default(8),
});

/** Public, bounded local user directory used by federated mention typeahead. */
export async function GET(request: NextRequest) {
  const readAuthorization = await authorizeFederationRead(request);
  if (!readAuthorization.ok) return federationReadFailureResponse(readAuthorization);
  const parsed = querySchema.safeParse({
    q: request.nextUrl.searchParams.get('q') || '',
    limit: request.nextUrl.searchParams.get('limit') || undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid query' }, { status: 400 });
  }

  const query = parsed.data.q.toLowerCase();
  const nodeIsNsfw = await requireLocalNodeNsfwClassification();
  const trustedRead = true;
  const matches = await db.select({
    handle: users.handle,
    displayName: users.displayName,
    avatarUrl: users.avatarUrl,
    isNsfw: users.isNsfw,
    nodeId: users.nodeId,
  })
    .from(users)
    .where(and(
      or(like(users.handle, `${query}%`), like(users.displayName, `${query}%`)),
      isNull(users.nodeId),
      notLike(users.handle, '%@%'),
      eq(users.isSuspended, false),
      eq(users.isSilenced, false),
    ))
    .orderBy(asc(users.handle))
    .limit(parsed.data.limit);

  return NextResponse.json({
    users: matches.filter(hasStrictLocalUserOrigin).map((user) => {
      const summary = {
        handle: user.handle,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        isNsfw: user.isNsfw,
        isRemote: false,
        nodeIsNsfw,
      };
      return trustedRead ? summary : redactSensitiveUserSummary(summary, false);
    }),
  });
}
