import { and, eq, isNull } from 'drizzle-orm';

import { db, pushMessageDeliveries, pushSubscriptions } from '@/db';

type PushMessageWriter = Pick<typeof db, 'insert' | 'select'>;

/** Queue one push-only delivery per active device in the same transaction as
 * the recipient's encrypted chat message. No Alerts notification is created. */
export async function enqueueMessagePushDeliveries(
  writer: PushMessageWriter,
  recipientUserId: string,
  messageId: string,
): Promise<number> {
  const subscriptions = await writer.select({ id: pushSubscriptions.id })
    .from(pushSubscriptions)
    .where(and(
      eq(pushSubscriptions.userId, recipientUserId),
      isNull(pushSubscriptions.disabledAt),
    ));
  if (subscriptions.length === 0) return 0;

  await writer.insert(pushMessageDeliveries).values(subscriptions.map((subscription) => ({
    messageId,
    subscriptionId: subscription.id,
  }))).onConflictDoNothing();
  return subscriptions.length;
}
