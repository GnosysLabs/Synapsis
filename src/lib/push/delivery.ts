import { and, eq, lte, or } from 'drizzle-orm';

import {
  db,
  pushDeliveries,
  pushMessageDeliveries,
  pushSubscriptions,
} from '@/db';
import { openPushDeliveryToken } from '@/lib/push/credentials';

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
  // Remote presentation text is safe in-app because the verified handle is
  // displayed beside it. A lock-screen push has no such identity context.
  return notification.actorId
    ? notification.actorDisplayName || notification.actorHandle
    : notification.actorHandle;
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

  const response = await sendRelayEvent(subscription, {
    eventId: delivery.id,
    notificationId: notification.id,
    type: notification.type,
    actorName: pushNotificationActorName(notification),
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
): Promise<'delivered' | 'retry' | 'dead'> {
  const [subscription, message] = await Promise.all([
    db.query.pushSubscriptions.findFirst({ where: { id: delivery.subscriptionId } }),
    db.query.chatMessages.findFirst({ where: { id: delivery.messageId } }),
  ]);

  if (!subscription || !message || subscription.disabledAt) {
    return updateMessageFailure(delivery, 'Subscription or message no longer exists', false);
  }

  const response = await sendRelayEvent(subscription, {
    eventId: delivery.id,
    messageId: message.clientMessageId || message.id,
    type: 'message',
    actorName: message.senderDisplayName || message.senderHandle,
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
      const state = await deliverOne(delivery);
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
      const state = await deliverMessage(delivery);
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
