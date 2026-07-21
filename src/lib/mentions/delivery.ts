import { randomUUID } from 'node:crypto';
import { and, eq, lte, notInArray, or } from 'drizzle-orm';

import {
  db,
  mentionDeliveries,
  notifications,
} from '@/db';
import { discoverNode } from '@/lib/swarm/discovery';
import {
  deliverSwarmMention,
  isSwarmNode,
  type SwarmInteractionResponse,
} from '@/lib/swarm/interactions';
import { parseMentions, uniqueMentions } from './parser';
import {
  signedUserActionSchema,
  type SignedUserAction,
} from '@/lib/e2ee/protocol';
import {
  canonicalAccountHomeDomain,
  requireCanonicalAccountHomeDomain,
  resolveAccountAddress,
} from '@/lib/identity/account-address';
import {
  getBlockedNodeDomains,
  isNodeBlocked,
} from '@/lib/swarm/node-blocklist';

const MAX_DELIVERY_ATTEMPTS = 12;
const PROCESSING_LEASE_MS = 2 * 60 * 1000;
let activeWorker: Promise<MentionOutboxResult> | null = null;

export interface MentionActor {
  id: string;
  handle: string;
  displayName: string | null;
  avatarUrl: string | null;
  did?: string | null;
  publicKey?: string | null;
}

export interface RegisterPostMentionsInput {
  postId: string;
  content: string;
  actor: MentionActor;
  nodeDomain?: string;
  userAction?: SignedUserAction;
}

export interface RegisterPostMentionsResult {
  localNotifications: number;
  remoteQueued: number;
  skipped: number;
}

export interface MentionOutboxResult {
  delivered: number;
  retried: number;
  dead: number;
}

export function mentionRetryDelayMs(attempt: number): number {
  return Math.min(60 * 60 * 1000, 30 * 1000 * (2 ** Math.max(0, attempt - 1)));
}

async function localInteractionAllowed(recipientId: string, actorId: string): Promise<boolean> {
  const [block, mute] = await Promise.all([
    db.query.blocks.findFirst({
      where: {
        OR: [
          { AND: [{ userId: recipientId }, { blockedUserId: actorId }] },
          { AND: [{ userId: actorId }, { blockedUserId: recipientId }] },
        ],
      },
      columns: { id: true },
    }),
    db.query.mutes.findFirst({
      where: { AND: [{ userId: recipientId }, { mutedUserId: actorId }] },
      columns: { id: true },
    }),
  ]);
  return !block && !mute;
}

async function insertMentionNotification(values: typeof notifications.$inferInsert): Promise<boolean> {
  const inserted = await db.insert(notifications)
    .values(values)
    .onConflictDoNothing()
    .returning({ id: notifications.id });
  return inserted.length > 0;
}

/** Resolve local mentions synchronously and persist remote delivery work. */
export async function registerPostMentions(
  input: RegisterPostMentionsInput,
): Promise<RegisterPostMentionsResult> {
  const nodeDomain = requireCanonicalAccountHomeDomain(
    input.nodeDomain || process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:43821',
  );
  const mentions = uniqueMentions(parseMentions(input.content, nodeDomain));
  const result: RegisterPostMentionsResult = {
    localNotifications: 0,
    remoteQueued: 0,
    skipped: 0,
  };

  for (const mention of mentions) {
    if (mention.isLocal) {
      const mentionedUser = await db.query.users.findFirst({
        where: {
          AND: [
            { handle: mention.canonicalHandle },
            { isLocalAccount: true },
          ],
        },
      });
      if (!mentionedUser
        || mentionedUser.id === input.actor.id
        || mentionedUser.isSuspended
        || !(await localInteractionAllowed(mentionedUser.id, input.actor.id))) {
        result.skipped += 1;
        continue;
      }

      const created = await insertMentionNotification({
        userId: mentionedUser.id,
        actorId: input.actor.id,
        actorHandle: input.actor.handle,
        actorDisplayName: input.actor.displayName,
        actorAvatarUrl: input.actor.avatarUrl,
        actorNodeDomain: nodeDomain,
        postId: input.postId,
        postContent: input.content.slice(0, 200),
        interactionId: `mention:local:${input.postId}:${mentionedUser.id}`,
        type: 'mention',
      });
      if (created) result.localNotifications += 1;
      continue;
    }

    if (!mention.domain) {
      result.skipped += 1;
      continue;
    }
    if (!input.userAction) {
      // Session/CLI posts cannot be attributed to a user key on another node.
      // Publish locally, but never substitute a node assertion for user proof.
      result.skipped += 1;
      continue;
    }

    const targetDomain = canonicalAccountHomeDomain(mention.domain);
    if (!targetDomain || await isNodeBlocked(targetDomain)) {
      result.skipped += 1;
      continue;
    }
    const inserted = await db.insert(mentionDeliveries).values({
      interactionId: randomUUID(),
      postId: input.postId,
      targetHandle: mention.canonicalHandle,
      targetDomain,
      userActionJson: JSON.stringify(input.userAction),
      status: 'pending',
      nextAttemptAt: new Date(),
    }).onConflictDoNothing().returning({ id: mentionDeliveries.id });
    if (inserted.length > 0) result.remoteQueued += 1;
  }

  if (result.remoteQueued > 0) {
    void processMentionDeliveryOutbox().catch((error) => {
      console.error('[Mentions] Immediate outbox processing failed:', error);
    });
  }
  return result;
}

async function markDeliveryFailure(
  delivery: typeof mentionDeliveries.$inferSelect,
  response: SwarmInteractionResponse,
): Promise<'retry' | 'dead'> {
  const attempts = delivery.attempts + 1;
  const isDead = response.retryable === false || attempts >= MAX_DELIVERY_ATTEMPTS;
  const now = new Date();
  await db.update(mentionDeliveries).set({
    status: isDead ? 'dead' : 'retry',
    attempts,
    nextAttemptAt: isDead ? now : new Date(now.getTime() + mentionRetryDelayMs(attempts)),
    lastError: (response.error || 'Unknown delivery failure').slice(0, 1000),
    updatedAt: now,
  }).where(eq(mentionDeliveries.id, delivery.id));
  return isDead ? 'dead' : 'retry';
}

async function attemptMentionDelivery(
  delivery: typeof mentionDeliveries.$inferSelect,
): Promise<'delivered' | 'retry' | 'dead'> {
  const targetDomain = canonicalAccountHomeDomain(delivery.targetDomain);
  if (!targetDomain) {
    return markDeliveryFailure(delivery, {
      success: false,
      retryable: false,
      error: 'Mention target has an invalid destination node',
    });
  }
  if (await isNodeBlocked(targetDomain)) {
    return markDeliveryFailure(delivery, {
      success: false,
      retryable: false,
      error: `Mention destination ${targetDomain} is blocked`,
    });
  }

  const post = await db.query.posts.findFirst({
    where: { id: delivery.postId },
    with: { author: true },
  });
  if (!post || post.isRemoved || post.author.isSuspended) {
    return markDeliveryFailure(delivery, {
      success: false,
      retryable: false,
      error: 'Source post or actor is unavailable',
    });
  }

  let userAction: SignedUserAction;
  try {
    userAction = signedUserActionSchema.parse(JSON.parse(delivery.userActionJson || 'null'));
  } catch {
    return markDeliveryFailure(delivery, {
      success: false,
      retryable: false,
      error: 'Mention delivery is missing its original user authorization',
    });
  }

  let knownNode = await isSwarmNode(targetDomain);
  if (!knownNode) knownNode = (await discoverNode(targetDomain)).success;
  if (!knownNode) {
    return markDeliveryFailure(delivery, {
      success: false,
      retryable: true,
      error: `Unable to discover Synapsis node ${targetDomain}`,
    });
  }

  const targetAddress = resolveAccountAddress(delivery.targetHandle, targetDomain);
  if (!targetAddress || targetAddress.homeDomain !== targetDomain) {
    return markDeliveryFailure(delivery, {
      success: false,
      retryable: false,
      error: 'Mention target does not belong to its destination node',
    });
  }

  const response = await deliverSwarmMention(targetDomain, {
    userAction,
    mentionedHandle: targetAddress.canonical,
    mention: {
      actorHandle: post.author.handle,
      actorDisplayName: post.author.displayName || post.author.handle,
      actorAvatarUrl: post.author.avatarUrl || undefined,
      actorNodeDomain: requireCanonicalAccountHomeDomain(
        process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:43821',
      ),
      actorDid: post.author.did,
      actorPublicKey: post.author.publicKey,
      postId: post.id,
      postContent: post.content,
      interactionId: delivery.interactionId,
      timestamp: new Date().toISOString(),
    },
  });

  if (!response.success) return markDeliveryFailure(delivery, response);

  await db.update(mentionDeliveries).set({
    status: 'delivered',
    attempts: delivery.attempts + 1,
    deliveredAt: new Date(),
    lastError: null,
    updatedAt: new Date(),
  }).where(eq(mentionDeliveries.id, delivery.id));
  return 'delivered';
}

async function runMentionDeliveryOutbox(limit: number): Promise<MentionOutboxResult> {
  const result: MentionOutboxResult = { delivered: 0, retried: 0, dead: 0 };
  const now = new Date();
  const staleBefore = new Date(now.getTime() - PROCESSING_LEASE_MS);
  const blockedDomains = Array.from(await getBlockedNodeDomains());
  const unblockedTarget = blockedDomains.length > 0
    ? notInArray(mentionDeliveries.targetDomain, blockedDomains)
    : undefined;

  await db.update(mentionDeliveries).set({ status: 'retry', nextAttemptAt: now, updatedAt: now })
    .where(and(
      eq(mentionDeliveries.status, 'processing'),
      lte(mentionDeliveries.lastAttemptAt, staleBefore),
      unblockedTarget,
    ));

  const due = await db.select().from(mentionDeliveries)
    .where(and(
      or(eq(mentionDeliveries.status, 'pending'), eq(mentionDeliveries.status, 'retry')),
      lte(mentionDeliveries.nextAttemptAt, now),
      unblockedTarget,
    ))
    .limit(Math.max(1, Math.min(limit, 100)));

  for (const delivery of due) {
    if (await isNodeBlocked(delivery.targetDomain)) {
      const cancelled = await db.update(mentionDeliveries).set({
        status: 'dead',
        nextAttemptAt: now,
        lastError: 'Mention destination was blocked before delivery',
        updatedAt: now,
      }).where(and(
        eq(mentionDeliveries.id, delivery.id),
        or(eq(mentionDeliveries.status, 'pending'), eq(mentionDeliveries.status, 'retry')),
      )).returning({ id: mentionDeliveries.id });
      if (cancelled.length > 0) result.dead += 1;
      continue;
    }

    const claimed = await db.update(mentionDeliveries).set({
      status: 'processing',
      lastAttemptAt: new Date(),
      updatedAt: new Date(),
    }).where(and(
      eq(mentionDeliveries.id, delivery.id),
      or(eq(mentionDeliveries.status, 'pending'), eq(mentionDeliveries.status, 'retry')),
    )).returning({ id: mentionDeliveries.id });
    if (claimed.length === 0) continue;

    try {
      const state = await attemptMentionDelivery(delivery);
      result[state === 'retry' ? 'retried' : state] += 1;
    } catch (error) {
      const state = await markDeliveryFailure(delivery, {
        success: false,
        retryable: true,
        error: error instanceof Error ? error.message : String(error),
      });
      result[state === 'dead' ? 'dead' : 'retried'] += 1;
    }
  }
  return result;
}

export async function processMentionDeliveryOutbox(limit = 25): Promise<MentionOutboxResult> {
  if (activeWorker) return activeWorker;
  activeWorker = runMentionDeliveryOutbox(limit);
  try {
    return await activeWorker;
  } finally {
    activeWorker = null;
  }
}
