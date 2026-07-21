import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db, feedImpressions } from '@/db';
import { requireAuth } from '@/lib/auth';
import { resolveAccountAddress } from '@/lib/identity/account-address';
import { canonicalAccountHomeDomain } from '@/lib/identity/account-address';
import { sql } from 'drizzle-orm';

const impressionSchema = z.object({
  postKey: z.string().min(1).max(1_024),
  authorHandle: z.string().min(1).max(640),
  nodeDomain: z.string().min(1).max(255),
});

export async function POST(request: Request) {
  try {
    const viewer = await requireAuth();
    const input = impressionSchema.parse(await request.json());
    const nodeDomain = canonicalAccountHomeDomain(input.nodeDomain);
    const author = resolveAccountAddress(input.authorHandle, nodeDomain);
    if (!nodeDomain || !author || author.homeDomain !== nodeDomain) {
      return NextResponse.json({ error: 'Invalid post origin' }, { status: 400 });
    }

    const now = new Date();
    await db.insert(feedImpressions).values({
      userId: viewer.id,
      postKey: input.postKey,
      authorHandle: author.canonical,
      nodeDomain,
      firstSeenAt: now,
      lastSeenAt: now,
      viewCount: 1,
    }).onConflictDoUpdate({
      target: [feedImpressions.userId, feedImpressions.postKey],
      set: {
        authorHandle: author.canonical,
        nodeDomain,
        lastSeenAt: now,
        viewCount: sql`min(1000, ${feedImpressions.viewCount} + 1)`,
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid impression' }, { status: 400 });
    }
    if (error instanceof Error && error.message === 'Authentication required') {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }
    console.error('Record feed impression error:', error);
    return NextResponse.json({ error: 'Failed to record impression' }, { status: 500 });
  }
}
