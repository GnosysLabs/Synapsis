import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db, feedFeedback } from '@/db';
import { requireAuth } from '@/lib/auth';
import {
  canonicalAccountHomeDomain,
  resolveAccountAddress,
} from '@/lib/identity/account-address';

const feedbackSchema = z.object({
  postKey: z.string().min(1).max(1_024),
  authorHandle: z.string().min(1).max(640),
  nodeDomain: z.string().min(1).max(255),
  kind: z.literal('not_interested'),
});

export async function POST(request: Request) {
  try {
    const viewer = await requireAuth();
    const input = feedbackSchema.parse(await request.json());
    const nodeDomain = canonicalAccountHomeDomain(input.nodeDomain);
    const author = resolveAccountAddress(input.authorHandle, nodeDomain);
    if (!nodeDomain || !author || author.homeDomain !== nodeDomain) {
      return NextResponse.json({ error: 'Invalid post origin' }, { status: 400 });
    }

    const now = new Date();
    await db.insert(feedFeedback).values({
      userId: viewer.id,
      postKey: input.postKey,
      authorHandle: author.canonical,
      nodeDomain,
      kind: input.kind,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: [feedFeedback.userId, feedFeedback.postKey],
      set: {
        authorHandle: author.canonical,
        nodeDomain,
        kind: input.kind,
        updatedAt: now,
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid feedback' }, { status: 400 });
    }
    if (error instanceof Error && error.message === 'Authentication required') {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }
    console.error('Record feed feedback error:', error);
    return NextResponse.json({ error: 'Failed to record feedback' }, { status: 500 });
  }
}
