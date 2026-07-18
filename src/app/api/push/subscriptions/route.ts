import { and, eq } from 'drizzle-orm';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { db, pushSubscriptions } from '@/db';
import { requireAuth } from '@/lib/auth';
import { sealPushDeliveryToken } from '@/lib/push/credentials';

const SYNAPSIS_IOS_TOPIC = 'xyz.gnosyslabs.synapsis';

const preferencesSchema = z.object({
  follow: z.boolean(),
  reply: z.boolean(),
  mention: z.boolean(),
  like: z.boolean(),
  repost: z.boolean(),
}).strict();

const upsertSchema = z.object({
  installationId: z.uuid(),
  relaySubscriptionId: z.uuid(),
  relayDeliveryToken: z.string().min(32).max(256).regex(/^[A-Za-z0-9_-]+$/),
  environment: z.enum(['sandbox', 'production']),
  topic: z.literal(SYNAPSIS_IOS_TOPIC),
  preferences: preferencesSchema,
}).strict();

const deleteSchema = z.object({ installationId: z.uuid() }).strict();

function authError(error: unknown): boolean {
  return error instanceof Error && /auth|session/i.test(error.message);
}

export async function PUT(request: NextRequest) {
  try {
    const user = await requireAuth();
    const parsed = upsertSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid push subscription' }, { status: 400 });
    }

    const value = parsed.data;
    const now = new Date();
    const encryptedToken = sealPushDeliveryToken(
      value.relayDeliveryToken,
      user.id,
      value.installationId,
    );

    await db.insert(pushSubscriptions).values({
      userId: user.id,
      installationId: value.installationId,
      relaySubscriptionId: value.relaySubscriptionId,
      relayDeliveryTokenEncrypted: encryptedToken,
      environment: value.environment,
      topic: value.topic,
      followEnabled: value.preferences.follow,
      replyEnabled: value.preferences.reply,
      mentionEnabled: value.preferences.mention,
      likeEnabled: value.preferences.like,
      repostEnabled: value.preferences.repost,
      disabledAt: null,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: [pushSubscriptions.userId, pushSubscriptions.installationId],
      set: {
        relaySubscriptionId: value.relaySubscriptionId,
        relayDeliveryTokenEncrypted: encryptedToken,
        environment: value.environment,
        topic: value.topic,
        followEnabled: value.preferences.follow,
        replyEnabled: value.preferences.reply,
        mentionEnabled: value.preferences.mention,
        likeEnabled: value.preferences.like,
        repostEnabled: value.preferences.repost,
        disabledAt: null,
        updatedAt: now,
      },
    });

    return new NextResponse(null, { status: 204 });
  } catch (error) {
    if (authError(error)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('[Push] Subscription registration failed:', error);
    return NextResponse.json({ error: 'Failed to register push subscription' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const user = await requireAuth();
    const parsed = deleteSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid installation ID' }, { status: 400 });
    }

    await db.delete(pushSubscriptions).where(and(
      eq(pushSubscriptions.userId, user.id),
      eq(pushSubscriptions.installationId, parsed.data.installationId),
    ));
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    if (authError(error)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('[Push] Subscription removal failed:', error);
    return NextResponse.json({ error: 'Failed to remove push subscription' }, { status: 500 });
  }
}
