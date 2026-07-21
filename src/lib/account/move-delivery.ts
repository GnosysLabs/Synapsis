import { and, eq, inArray, lte } from 'drizzle-orm';

import { accountMoveDeliveries, db } from '@/db';
import {
  deliverAccountMoveNotice,
  type SignedAccountMoveNotice,
} from '@/lib/account/move-notification';

const DELIVERY_BATCH_SIZE = 10;
let activeWorker: Promise<AccountMoveDeliveryResult> | null = null;

export interface AccountMoveDeliveryResult {
  confirmed: number;
  retrying: number;
}

export function accountMoveRetryDelayMs(attempt: number): number {
  return Math.min(24 * 60 * 60 * 1_000, 60 * 1_000 * (2 ** Math.max(0, attempt - 1)));
}

function noticeFromDelivery(
  delivery: typeof accountMoveDeliveries.$inferSelect,
): SignedAccountMoveNotice {
  return {
    oldHandle: delivery.oldHandle,
    newActorUrl: delivery.newActorUrl,
    did: delivery.did,
    movedAt: delivery.movedAt.toISOString(),
    signature: delivery.signature,
  };
}

async function attemptDelivery(
  delivery: typeof accountMoveDeliveries.$inferSelect,
): Promise<boolean> {
  try {
    if (delivery.sourceProtocol !== 'http' && delivery.sourceProtocol !== 'https') {
      throw new Error('Stored source protocol is invalid');
    }
    await deliverAccountMoveNotice({
      sourceNode: delivery.sourceNode,
      sourceProtocol: delivery.sourceProtocol,
      notice: noticeFromDelivery(delivery),
    });
    const now = new Date();
    await db.update(accountMoveDeliveries).set({
      status: 'confirmed',
      confirmedAt: now,
      lastError: null,
      updatedAt: now,
    }).where(eq(accountMoveDeliveries.id, delivery.id));
    return true;
  } catch (error) {
    const attempts = delivery.attempts + 1;
    const now = new Date();
    await db.update(accountMoveDeliveries).set({
      status: 'retry',
      attempts,
      nextAttemptAt: new Date(now.getTime() + accountMoveRetryDelayMs(attempts)),
      lastError: (error instanceof Error ? error.message : 'Source cleanup failed').slice(0, 1_000),
      updatedAt: now,
    }).where(eq(accountMoveDeliveries.id, delivery.id));
    return false;
  }
}

async function runDeliveryBatch(): Promise<AccountMoveDeliveryResult> {
  const due = await db.select().from(accountMoveDeliveries).where(and(
    inArray(accountMoveDeliveries.status, ['pending', 'retry']),
    lte(accountMoveDeliveries.nextAttemptAt, new Date()),
  )).limit(DELIVERY_BATCH_SIZE);
  const result = { confirmed: 0, retrying: 0 };
  for (const delivery of due) {
    if (await attemptDelivery(delivery)) result.confirmed += 1;
    else result.retrying += 1;
  }
  return result;
}

export async function processAccountMoveDeliveryOutbox(): Promise<AccountMoveDeliveryResult> {
  if (activeWorker) return activeWorker;
  activeWorker = runDeliveryBatch().finally(() => {
    activeWorker = null;
  });
  return activeWorker;
}

export async function retryAccountMoveForUser(userId: string): Promise<boolean> {
  const delivery = await db.query.accountMoveDeliveries.findFirst({ where: { userId } });
  if (!delivery) throw new Error('No source cleanup is recorded for this account');
  if (delivery.status === 'confirmed') return true;
  return attemptDelivery(delivery);
}
