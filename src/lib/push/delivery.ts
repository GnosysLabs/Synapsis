import { and, eq, isNull, lte, ne, or, sql } from 'drizzle-orm';

import {
  chatConversations,
  chatMessages,
  db,
  notifications,
  pushDeliveries,
  pushMessageDeliveries,
  pushSubscriptions,
} from '@/db';
import {
  canonicalAccountHomeDomain,
  requireCanonicalAccountHomeDomain,
  resolveAccountAddress,
} from '@/lib/identity/account-address';
import { requireLocalNodeNsfwClassification } from '@/lib/node/local-node';
import { isUserSensitive } from '@/lib/nsfw/content-visibility';
import { shouldIncludeNsfwFeed } from '@/lib/nsfw/feed-access';
import { openPushDeliveryToken } from '@/lib/push/credentials';
import { isNodeBlocked } from '@/lib/swarm/node-blocklist';

const DEFAULT_RELAY_URL = 'https://push.synapsis.social';
const MAX_DELIVERY_ATTEMPTS = 12;
const PROCESSING_LEASE_MS = 2 * 60 * 1000;
let activeWorker: Promise<PushOutboxResult> | null = null;

export interface PushOutboxResult {
  delivered: number;
  retried: number;
  dead: number;
}

export function pushNotificationActorName(notification: {
  actorId: string | null;
  actorDisplayName: string | null;
  actorHandle: string;
}): string {
  return notification.actorDisplayName?.trim() || notification.actorHandle;
}

export function pushActorAvatarUrl(value: string | null | undefined): string | undefined {
  if (!value || value.length > 2_048) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

export function pushDiceBearAvatarUrl(
  actorHandle: string,
  actorNodeDomain?: string | null,
): string {
  const canonical = resolveAccountAddress(actorHandle, actorNodeDomain)?.canonical;
  const normalized = (canonical || actorHandle)
    .trim()
    .replace(/^@+/, '')
    .slice(0, 640) || 'synapsis-user';
  const url = new URL('https://api.dicebear.com/9.x/bottts-neutral/png');
  url.searchParams.set('seed', normalized);
  return url.toString();
}

export interface PushAvatarVisibilityInput {
  actorHandle: string;
  actorNodeDomain?: string | null;
  actorAvatarUrl?: string | null;
  actorAccountIsNsfw?: boolean;
  actorNodeIsNsfw?: boolean;
  actorIsRemote: boolean;
  recipientNsfwEnabled?: boolean;
  recipientAgeVerifiedAt?: Date | string | null;
  localNodeIsNsfw: boolean;
}

// Resolve the safe URL before contacting the relay. A restricted custom URL
// must never enter the relay payload, APNs payload, or notification extension.
export function pushActorAvatarUrlForViewer(input: PushAvatarVisibilityInput): string {
  const canViewSensitive = shouldIncludeNsfwFeed({
    viewer: {
      nsfwEnabled: input.recipientNsfwEnabled,
      ageVerifiedAt: input.recipientAgeVerifiedAt,
    },
    localNodeIsNsfw: input.localNodeIsNsfw,
  });
  const actorIsSensitive = isUserSensitive({
    accountIsNsfw: input.actorAccountIsNsfw,
    nodeIsNsfw: input.actorNodeIsNsfw,
    isRemote: input.actorIsRemote,
  });
  const placeholder = pushDiceBearAvatarUrl(input.actorHandle, input.actorNodeDomain);

  if (actorIsSensitive && !canViewSensitive) return placeholder;
  return pushActorAvatarUrl(input.actorAvatarUrl) || placeholder;
}

interface PushActorPresentationInput {
  recipientUserId: string;
  actorId?: string | null;
  actorHandle: string;
  actorNodeDomain: string;
  actorAvatarUrl?: string | null;
  localNodeIsNsfw: boolean;
}

async function resolvedPushActorAvatarUrl(input: PushActorPresentationInput): Promise<string> {
  const actorAddress = resolveAccountAddress(input.actorHandle, input.actorNodeDomain);
  const canonicalActorHandle = actorAddress?.canonical || input.actorHandle;
  const [recipient, actorByIdentity] = await Promise.all([
    db.query.users.findFirst({ where: { id: input.recipientUserId } }),
    input.actorId
      ? db.query.users.findFirst({ where: { id: input.actorId } })
      : db.query.users.findFirst({ where: { handle: canonicalActorHandle } }),
  ]);
  if (!recipient) throw new Error('Push recipient no longer exists');

  const actorUser = actorByIdentity || (input.actorId
    ? await db.query.users.findFirst({ where: { handle: canonicalActorHandle } })
    : undefined);
  const localDomain = requireCanonicalAccountHomeDomain(
    process.env.NEXT_PUBLIC_NODE_DOMAIN || process.env.NODE_DOMAIN || 'localhost:43821',
  );
  const actorDomain = canonicalAccountHomeDomain(actorUser?.homeDomain)
    || actorAddress?.homeDomain
    || requireCanonicalAccountHomeDomain(input.actorNodeDomain);
  const actorIsRemote = actorUser
    ? !actorUser.isLocalAccount
    : actorDomain !== localDomain;
  const actorNode = actorIsRemote
    ? await db.query.swarmNodes.findFirst({
        where: { domain: actorDomain },
        columns: {
          isNsfw: true,
          nsfwClassificationKnown: true,
        },
      })
    : undefined;
  const actorNodeIsNsfw = actorIsRemote
    ? actorNode?.isNsfw === true
      ? true
      : actorNode?.nsfwClassificationKnown === true ? false : undefined
    : input.localNodeIsNsfw;

  return pushActorAvatarUrlForViewer({
    actorHandle: canonicalActorHandle,
    actorNodeDomain: actorDomain,
    actorAvatarUrl: input.actorAvatarUrl,
    actorAccountIsNsfw: actorUser?.isNsfw,
    actorNodeIsNsfw,
    actorIsRemote,
    recipientNsfwEnabled: recipient.nsfwEnabled,
    recipientAgeVerifiedAt: recipient.ageVerifiedAt,
    localNodeIsNsfw: input.localNodeIsNsfw,
  });
}

function retryDelayMs(attempt: number): number {
  return Math.min(60 * 60 * 1000, 15 * 1000 * (2 ** Math.max(0, attempt - 1)));
}

function relayURL(): URL {
  const url = new URL(process.env.PUSH_RELAY_URL || DEFAULT_RELAY_URL);
  const localDevelopment = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(process.env.NODE_ENV !== 'production' && localDevelopment)) {
    throw new Error('PUSH_RELAY_URL must use HTTPS');
  }
  return url;
}

function preferenceAllows(
  subscription: typeof pushSubscriptions.$inferSelect,
  type: string,
): boolean {
  switch (type) {
    case 'follow': return subscription.followEnabled;
    case 'reply': return subscription.replyEnabled;
    case 'mention': return subscription.mentionEnabled;
    case 'like': return subscription.likeEnabled;
    case 'repost': return subscription.repostEnabled;
    default: return false;
  }
}

async function unreadPushBadge(userId: string): Promise<number> {
  const recipient = await db.query.users.findFirst({
    where: { id: userId },
    columns: { handle: true },
  });
  if (!recipient) return 0;

  const [notificationRows, messageRows] = await Promise.all([
    db.select({ count: sql<number>`count(*)` })
      .from(notifications)
      .where(and(
        eq(notifications.userId, userId),
        isNull(notifications.readAt),
      )),
    db.select({ count: sql<number>`count(*)` })
      .from(chatMessages)
      .innerJoin(
        chatConversations,
        eq(chatMessages.conversationId, chatConversations.id),
      )
      .where(and(
        eq(chatConversations.participant1Id, userId),
        isNull(chatMessages.readAt),
        ne(chatMessages.senderHandle, recipient.handle),
      )),
  ]);

  const unreadNotifications = Number(notificationRows[0]?.count || 0);
  const unreadMessages = Number(messageRows[0]?.count || 0);
  return Math.max(0, Math.min(999_999, unreadNotifications + unreadMessages));
}

async function sendRelayEvent(
  subscription: typeof pushSubscriptions.$inferSelect,
  event: Record<string, unknown>,
): Promise<Response> {
  const token = openPushDeliveryToken(
    subscription.relayDeliveryTokenEncrypted,
    subscription.userId,
    subscription.installationId,
  );
  const endpoint = new URL(
    `/v1/subscriptions/${encodeURIComponent(subscription.relaySubscriptionId)}/deliver`,
    relayURL(),
  );
  return fetch(endpoint, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(event),
    signal: AbortSignal.timeout(15_000),
  });
}

async function disableSubscription(subscriptionId: string): Promise<void> {
  await db.update(pushSubscriptions).set({
    disabledAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(pushSubscriptions.id, subscriptionId));
}

async function updateFailure(
  delivery: typeof pushDeliveries.$inferSelect,
  message: string,
  retryable: boolean,
): Promise<'retry' | 'dead'> {
  const attempts = delivery.attempts + 1;
  const dead = !retryable || attempts >= MAX_DELIVERY_ATTEMPTS;
  const now = new Date();
  await db.update(pushDeliveries).set({
    status: dead ? 'dead' : 'retry',
    attempts,
    nextAttemptAt: dead ? now : new Date(now.getTime() + retryDelayMs(attempts)),
    lastError: message.slice(0, 1000),
    updatedAt: now,
  }).where(eq(pushDeliveries.id, delivery.id));
  return dead ? 'dead' : 'retry';
}

async function deliverOne(
  delivery: typeof pushDeliveries.$inferSelect,
  localNodeIsNsfw: boolean,
): Promise<'delivered' | 'retry' | 'dead'> {
  const [subscription, notification] = await Promise.all([
    db.query.pushSubscriptions.findFirst({ where: { id: delivery.subscriptionId } }),
    db.query.notifications.findFirst({ where: { id: delivery.notificationId } }),
  ]);

  if (!subscription || !notification || subscription.disabledAt) {
    return updateFailure(delivery, 'Subscription or notification no longer exists', false);
  }
  if (!preferenceAllows(subscription, notification.type)) {
    return updateFailure(delivery, 'Notification type is disabled for this device', false);
  }
  if (
    await isNodeBlocked(notification.actorNodeDomain)
    || await isNodeBlocked(notification.remotePostDomain)
  ) {
    return updateFailure(delivery, 'Notification belongs to a blocked node', false);
  }

  const [actorAvatarUrl, badge] = await Promise.all([
    resolvedPushActorAvatarUrl({
      recipientUserId: subscription.userId,
      actorId: notification.actorId,
      actorHandle: notification.actorHandle,
      actorNodeDomain: notification.actorNodeDomain,
      actorAvatarUrl: notification.actorAvatarUrl,
      localNodeIsNsfw,
    }),
    unreadPushBadge(subscription.userId),
  ]);

  const response = await sendRelayEvent(subscription, {
    eventId: delivery.id,
    notificationId: notification.id,
    type: notification.type,
    actorName: pushNotificationActorName(notification),
    actorAvatarUrl,
    badge,
    postId: notification.postId || notification.remotePostId || undefined,
  });

  if (response.ok) {
    const now = new Date();
    await db.update(pushDeliveries).set({
      status: 'delivered',
      attempts: delivery.attempts + 1,
      deliveredAt: now,
      lastError: null,
      updatedAt: now,
    }).where(eq(pushDeliveries.id, delivery.id));
    return 'delivered';
  }

  const body = (await response.text()).slice(0, 800);
  const permanentlyInvalid = [401, 404, 410].includes(response.status);
  if (permanentlyInvalid) {
    await disableSubscription(subscription.id);
  }
  return updateFailure(
    delivery,
    `Relay returned ${response.status}${body ? `: ${body}` : ''}`,
    !permanentlyInvalid && (response.status === 408 || response.status === 429 || response.status >= 500),
  );
}

async function updateMessageFailure(
  delivery: typeof pushMessageDeliveries.$inferSelect,
  message: string,
  retryable: boolean,
): Promise<'retry' | 'dead'> {
  const attempts = delivery.attempts + 1;
  const dead = !retryable || attempts >= MAX_DELIVERY_ATTEMPTS;
  const now = new Date();
  await db.update(pushMessageDeliveries).set({
    status: dead ? 'dead' : 'retry',
    attempts,
    nextAttemptAt: dead ? now : new Date(now.getTime() + retryDelayMs(attempts)),
    lastError: message.slice(0, 1000),
    updatedAt: now,
  }).where(eq(pushMessageDeliveries.id, delivery.id));
  return dead ? 'dead' : 'retry';
}

async function deliverMessage(
  delivery: typeof pushMessageDeliveries.$inferSelect,
  localNodeIsNsfw: boolean,
): Promise<'delivered' | 'retry' | 'dead'> {
  const [subscription, message] = await Promise.all([
    db.query.pushSubscriptions.findFirst({ where: { id: delivery.subscriptionId } }),
    db.query.chatMessages.findFirst({ where: { id: delivery.messageId } }),
  ]);

  if (!subscription || !message || subscription.disabledAt) {
    return updateMessageFailure(delivery, 'Subscription or message no longer exists', false);
  }
  if (await isNodeBlocked(message.senderNodeDomain)) {
    return updateMessageFailure(delivery, 'Message belongs to a blocked node', false);
  }

  const [actorAvatarUrl, badge] = await Promise.all([
    resolvedPushActorAvatarUrl({
      recipientUserId: subscription.userId,
      actorHandle: message.senderHandle,
      actorNodeDomain: message.senderNodeDomain,
      actorAvatarUrl: message.senderAvatarUrl,
      localNodeIsNsfw,
    }),
    unreadPushBadge(subscription.userId),
  ]);

  const response = await sendRelayEvent(subscription, {
    eventId: delivery.id,
    messageId: message.clientMessageId || message.id,
    type: 'message',
    actorName: message.senderDisplayName || message.senderHandle,
    actorAvatarUrl,
    badge,
  });
  if (response.ok) {
    const now = new Date();
    await db.update(pushMessageDeliveries).set({
      status: 'delivered',
      attempts: delivery.attempts + 1,
      deliveredAt: now,
      lastError: null,
      updatedAt: now,
    }).where(eq(pushMessageDeliveries.id, delivery.id));
    return 'delivered';
  }

  const body = (await response.text()).slice(0, 800);
  const permanentlyInvalid = [401, 404, 410].includes(response.status);
  if (permanentlyInvalid) await disableSubscription(subscription.id);
  return updateMessageFailure(
    delivery,
    `Relay returned ${response.status}${body ? `: ${body}` : ''}`,
    !permanentlyInvalid && (response.status === 408 || response.status === 429 || response.status >= 500),
  );
}

async function runPushDeliveryOutbox(limit: number): Promise<PushOutboxResult> {
  const result: PushOutboxResult = { delivered: 0, retried: 0, dead: 0 };
  const now = new Date();
  const staleBefore = new Date(now.getTime() - PROCESSING_LEASE_MS);
  let localNodeNsfwPromise: Promise<boolean> | undefined;
  const localNodeIsNsfw = () => {
    localNodeNsfwPromise ||= requireLocalNodeNsfwClassification();
    return localNodeNsfwPromise;
  };

  await db.update(pushDeliveries).set({ status: 'retry', nextAttemptAt: now, updatedAt: now })
    .where(and(
      eq(pushDeliveries.status, 'processing'),
      lte(pushDeliveries.lastAttemptAt, staleBefore),
    ));

  const due = await db.select().from(pushDeliveries).where(and(
    or(eq(pushDeliveries.status, 'pending'), eq(pushDeliveries.status, 'retry')),
    lte(pushDeliveries.nextAttemptAt, now),
  )).limit(Math.max(1, Math.min(limit, 100)));

  for (const delivery of due) {
    const claimed = await db.update(pushDeliveries).set({
      status: 'processing',
      lastAttemptAt: new Date(),
      updatedAt: new Date(),
    }).where(and(
      eq(pushDeliveries.id, delivery.id),
      or(eq(pushDeliveries.status, 'pending'), eq(pushDeliveries.status, 'retry')),
    )).returning({ id: pushDeliveries.id });
    if (claimed.length === 0) continue;

    try {
      const state = await deliverOne(delivery, await localNodeIsNsfw());
      result[state === 'retry' ? 'retried' : state] += 1;
    } catch (error) {
      const state = await updateFailure(
        delivery,
        error instanceof Error ? error.message : String(error),
        true,
      );
      result[state === 'dead' ? 'dead' : 'retried'] += 1;
    }
  }

  await db.update(pushMessageDeliveries).set({ status: 'retry', nextAttemptAt: now, updatedAt: now })
    .where(and(
      eq(pushMessageDeliveries.status, 'processing'),
      lte(pushMessageDeliveries.lastAttemptAt, staleBefore),
    ));

  const dueMessages = await db.select().from(pushMessageDeliveries).where(and(
    or(
      eq(pushMessageDeliveries.status, 'pending'),
      eq(pushMessageDeliveries.status, 'retry'),
    ),
    lte(pushMessageDeliveries.nextAttemptAt, now),
  )).limit(Math.max(1, Math.min(limit, 100)));

  for (const delivery of dueMessages) {
    const claimed = await db.update(pushMessageDeliveries).set({
      status: 'processing',
      lastAttemptAt: new Date(),
      updatedAt: new Date(),
    }).where(and(
      eq(pushMessageDeliveries.id, delivery.id),
      or(
        eq(pushMessageDeliveries.status, 'pending'),
        eq(pushMessageDeliveries.status, 'retry'),
      ),
    )).returning({ id: pushMessageDeliveries.id });
    if (claimed.length === 0) continue;

    try {
      const state = await deliverMessage(delivery, await localNodeIsNsfw());
      result[state === 'retry' ? 'retried' : state] += 1;
    } catch (error) {
      const state = await updateMessageFailure(
        delivery,
        error instanceof Error ? error.message : String(error),
        true,
      );
      result[state === 'dead' ? 'dead' : 'retried'] += 1;
    }
  }
  return result;
}

export async function processPushDeliveryOutbox(limit = 25): Promise<PushOutboxResult> {
  if (activeWorker) return activeWorker;
  activeWorker = runPushDeliveryOutbox(limit);
  try {
    return await activeWorker;
  } finally {
    activeWorker = null;
  }
}
