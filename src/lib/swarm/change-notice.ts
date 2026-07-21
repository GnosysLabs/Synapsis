import crypto from 'node:crypto';
import {
  db,
  swarmChangeNoticeStates,
  swarmContentSyncStates,
  swarmNodes,
} from '@/db';
import { mapWithConcurrency } from '@/lib/async/concurrency';
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  lt,
  lte,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import { z } from 'zod';
import { getPublicSwarmDomain, isPublicSwarmDomain } from './node-domain';
import { getNodesForChangeNotice, getTrustedSwarmReadPeerPublicKey } from './registry';
import { safeFederationRequest } from './safe-federation-http';
import { getNodePrivateKey, signPayload, verifySignature } from './signature';
import { syncSwarmContentNoticeOrigin } from './content-cache';
import {
  getBlockedNodeDomains,
  isNodeBlocked,
} from './node-blocklist';

export const CHANGE_NOTICE_MAX_BODY_BYTES = 64 * 1024;
export const CHANGE_NOTICE_MAX_BATCH = 50;
export const CHANGE_NOTICE_FANOUT = 3;
export const CHANGE_NOTICE_RELAY_ROUNDS = 5;
export const CHANGE_NOTICE_ROUND_MS = 750;
export const CHANGE_NOTICE_LIFETIME_MS = 120_000;
export const CHANGE_NOTICE_CLOCK_SKEW_MS = 30_000;
export const CHANGE_NOTICE_DIRECT_SPREAD_MS = 1_200;
export const CHANGE_NOTICE_RELAY_PULL_MIN_MS = 500;
export const CHANGE_NOTICE_RELAY_PULL_SPREAD_MS = 3_000;
export const CHANGE_NOTICE_DIRECT_FALLBACK_MIN_MS = 15_000;
export const CHANGE_NOTICE_DIRECT_FALLBACK_SPREAD_MS = 10_000;

const PROCESSING_LEASE_MS = 15_000;
const MAX_ORIGIN_SIGNATURE_BYTES = 2_048;

export const changeNoticeV1Schema = z.strictObject({
  type: z.literal('ChangeNotice'),
  version: z.literal(1),
  origin: z.string().min(1).max(253),
  cursor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
});

export const signedChangeNoticeSchema = z.strictObject({
  notice: changeNoticeV1Schema,
  signature: z.string().min(1).max(MAX_ORIGIN_SIGNATURE_BYTES),
});

export const changeNoticeEnvelopeSchema = z.strictObject({
  version: z.literal(1),
  sender: z.string().min(1).max(253),
  timestamp: z.string().datetime(),
  notices: z.array(signedChangeNoticeSchema).min(1).max(CHANGE_NOTICE_MAX_BATCH),
});

export type ChangeNoticeV1 = z.infer<typeof changeNoticeV1Schema>;
export type SignedChangeNotice = z.infer<typeof signedChangeNoticeSchema>;
export type ChangeNoticeEnvelope = z.infer<typeof changeNoticeEnvelopeSchema>;

export interface ChangeNoticeCycleResult {
  originated: boolean;
  relayed: number;
  relayTargets: number;
  immediatePulls: number;
  pullFailures: number;
}

export function validateChangeNoticeTiming(
  notice: ChangeNoticeV1,
  nowMs = Date.now(),
): string | null {
  const issuedAt = Date.parse(notice.issuedAt);
  const expiresAt = Date.parse(notice.expiresAt);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) return 'invalid timestamp';
  if (issuedAt > nowMs + CHANGE_NOTICE_CLOCK_SKEW_MS) return 'issued in the future';
  if (expiresAt <= issuedAt || expiresAt - issuedAt > CHANGE_NOTICE_LIFETIME_MS) {
    return 'invalid lifetime';
  }
  if (expiresAt < nowMs - CHANGE_NOTICE_CLOCK_SKEW_MS) return 'expired';
  return null;
}

function parsedRelayTargets(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((domain): domain is string => typeof domain === 'string').slice(0, 15)
      : [];
  } catch {
    return [];
  }
}

function parsedRelayHints(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? Array.from(new Set(parsed.flatMap((value) => {
          const domain = typeof value === 'string' ? getPublicSwarmDomain(value) : null;
          return domain && domain === value ? [domain] : [];
        }))).slice(0, 8)
      : [];
  } catch {
    return [];
  }
}

function deterministicWindowOffset(
  origin: string,
  cursor: number,
  receiver: string,
  purpose: string,
  spreadMs: number,
): number {
  if (spreadMs <= 0) return 0;
  const word = crypto.createHash('sha256')
    .update(`${purpose}\0${origin}\0${cursor}\0${receiver}`)
    .digest()
    .readUInt32BE(0);
  return word % (spreadMs + 1);
}

export interface ChangeNoticePullSchedule {
  pullAt: Date;
  directFallbackAt: Date;
  directRecipient: boolean;
}

/** Stable distribution prevents every receiver from waking in the same millisecond. */
export function getChangeNoticePullSchedule(
  notice: ChangeNoticeV1,
  relay: string,
  receiver: string,
  nowMs = Date.now(),
): ChangeNoticePullSchedule {
  const issuedAtMs = Math.min(Date.parse(notice.issuedAt), nowMs);
  const directRecipient = relay === notice.origin;
  const pullDelay = directRecipient
    ? deterministicWindowOffset(
        notice.origin,
        notice.cursor,
        receiver,
        'direct-pull',
        CHANGE_NOTICE_DIRECT_SPREAD_MS,
      )
    : CHANGE_NOTICE_RELAY_PULL_MIN_MS + deterministicWindowOffset(
        notice.origin,
        notice.cursor,
        receiver,
        'relay-pull',
        CHANGE_NOTICE_RELAY_PULL_SPREAD_MS,
      );
  const pullAtMs = Math.max(nowMs, issuedAtMs + pullDelay);
  const fallbackAtMs = directRecipient
    ? pullAtMs
    : Math.max(
        pullAtMs,
        issuedAtMs + CHANGE_NOTICE_DIRECT_FALLBACK_MIN_MS
          + deterministicWindowOffset(
            notice.origin,
            notice.cursor,
            receiver,
            'origin-fallback',
            CHANGE_NOTICE_DIRECT_FALLBACK_SPREAD_MS,
          ),
      );
  return {
    pullAt: new Date(pullAtMs),
    directFallbackAt: new Date(fallbackAtMs),
    directRecipient,
  };
}

async function originateLatestCursor(): Promise<boolean> {
  const origin = getPublicSwarmDomain(process.env.NEXT_PUBLIC_NODE_DOMAIN);
  if (!origin) return false;

  const clock = await db.query.swarmContentClock.findFirst({ where: { id: 1 } });
  const cursor = Number(clock?.sequence ?? 0);
  if (!Number.isSafeInteger(cursor) || cursor <= 0) return false;
  const existing = await db.query.swarmChangeNoticeStates.findFirst({
    where: { originDomain: origin },
  });
  if (existing && existing.sequence >= cursor) return false;

  const now = new Date();
  const expiresAt = new Date(now.getTime() + CHANGE_NOTICE_LIFETIME_MS);
  const notice: ChangeNoticeV1 = {
    type: 'ChangeNotice',
    version: 1,
    origin,
    cursor,
    issuedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
  const privateKey = await getNodePrivateKey();
  const signature = signPayload(notice, privateKey);
  const inserted = await db.insert(swarmChangeNoticeStates).values({
    originDomain: origin,
    sequence: cursor,
    issuedAt: now,
    expiresAt,
    noticeJson: JSON.stringify(notice),
    originSignature: signature,
    source: 'local',
    status: 'pending',
    relayRound: 0,
    relayTargetsJson: '[]',
    attempts: 0,
    nextAttemptAt: now,
    firstSeenAt: now,
    lastReceivedAt: null,
    lastForwardedAt: null,
    pullScheduledAt: null,
    relayHintsJson: '[]',
    directFallbackAt: null,
    lastDelayMs: 0,
    lastAttemptAt: null,
    lastError: null,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: swarmChangeNoticeStates.originDomain,
    set: {
      sequence: cursor,
      issuedAt: now,
      expiresAt,
      noticeJson: JSON.stringify(notice),
      originSignature: signature,
      source: 'local',
      status: 'pending',
      relayRound: 0,
      relayTargetsJson: '[]',
      attempts: 0,
      nextAttemptAt: now,
      firstSeenAt: now,
      lastReceivedAt: null,
      lastForwardedAt: null,
      pullScheduledAt: null,
      relayHintsJson: '[]',
      directFallbackAt: null,
      lastDelayMs: 0,
      lastAttemptAt: null,
      lastError: null,
      updatedAt: now,
    },
    setWhere: lt(swarmChangeNoticeStates.sequence, cursor),
  }).returning({ sequence: swarmChangeNoticeStates.sequence });
  if (inserted.length > 0) {
    console.log(`[ChangeNotice] Originated ${origin} cursor ${cursor}`);
  }
  return inserted.length > 0;
}

async function scheduleContentPull(
  origin: string,
  cursor: number,
  pullAt: Date,
  now: Date,
): Promise<void> {
  if (await isNodeBlocked(origin)) return;
  await db.update(swarmNodes).set({
    contentSequence: sql`max(coalesce(${swarmNodes.contentSequence}, 0), ${cursor})`,
    updatedAt: now,
  }).where(eq(swarmNodes.domain, origin));
  await db.insert(swarmContentSyncStates).values({
    domain: origin,
    nextAttemptAt: pullAt,
  }).onConflictDoNothing();
  await db.update(swarmContentSyncStates).set({
    nextAttemptAt: pullAt,
    updatedAt: now,
  }).where(and(
    eq(swarmContentSyncStates.domain, origin),
    gt(swarmContentSyncStates.nextAttemptAt, pullAt),
  ));
}

export type ChangeNoticeAcceptance =
  | { status: 'accepted'; delayMs: number }
  | { status: 'duplicate' }
  | { status: 'rejected'; reason: string };

/** Authenticate and monotonically coalesce one immutable origin notice. */
export async function acceptChangeNotice(
  entry: SignedChangeNotice,
  context: { relay: string },
): Promise<ChangeNoticeAcceptance> {
  const notice = entry.notice;
  const origin = getPublicSwarmDomain(notice.origin);
  if (!origin || origin !== notice.origin || !isPublicSwarmDomain(origin)) {
    return { status: 'rejected', reason: 'invalid origin' };
  }
  if (origin === getPublicSwarmDomain(process.env.NEXT_PUBLIC_NODE_DOMAIN)) {
    return { status: 'rejected', reason: 'self notice' };
  }
  if (await isNodeBlocked(origin)) {
    return { status: 'rejected', reason: 'blocked origin' };
  }
  const timingError = validateChangeNoticeTiming(notice);
  if (timingError) return { status: 'rejected', reason: timingError };
  const relay = getPublicSwarmDomain(context.relay);
  const receiver = getPublicSwarmDomain(process.env.NEXT_PUBLIC_NODE_DOMAIN);
  if (!relay || relay !== context.relay || !receiver) {
    return { status: 'rejected', reason: 'invalid relay hint' };
  }

  const existing = await db.query.swarmChangeNoticeStates.findFirst({
    where: { originDomain: origin },
  });
  if (existing && notice.cursor < existing.sequence) return { status: 'duplicate' };
  if (existing && notice.cursor === existing.sequence) {
    if (existing.noticeJson !== JSON.stringify(notice)
      || existing.originSignature !== entry.signature) {
      return { status: 'rejected', reason: 'cursor conflict' };
    }
    const relayHints = Array.from(new Set([
      ...parsedRelayHints(existing.relayHintsJson),
      relay,
    ])).slice(0, 8);
    await db.update(swarmChangeNoticeStates).set({
      relayHintsJson: JSON.stringify(relayHints),
      lastReceivedAt: new Date(),
      updatedAt: new Date(),
    }).where(and(
      eq(swarmChangeNoticeStates.originDomain, origin),
      eq(swarmChangeNoticeStates.sequence, notice.cursor),
    ));
    return { status: 'duplicate' };
  }

  const publicKey = await getTrustedSwarmReadPeerPublicKey(origin);
  if (!publicKey) return { status: 'rejected', reason: 'unknown origin' };
  if (!verifySignature(notice, entry.signature, publicKey)) {
    return { status: 'rejected', reason: 'invalid origin signature' };
  }
  if (await isNodeBlocked(origin)) {
    return { status: 'rejected', reason: 'blocked origin' };
  }

  const now = new Date();
  const issuedAt = new Date(notice.issuedAt);
  const expiresAt = new Date(notice.expiresAt);
  const delayMs = Math.max(0, now.getTime() - issuedAt.getTime());
  const schedule = getChangeNoticePullSchedule(notice, relay, receiver, now.getTime());
  const previousSync = existing?.source === 'remote'
    ? await db.query.swarmContentSyncStates.findFirst({ where: { domain: origin } })
    : null;
  const previousNoticeStillPending = Boolean(
    existing
    && Number(previousSync?.changeCursor ?? -1) < existing.sequence,
  );
  // A stream of higher notices may coalesce the cursor, but it must never
  // postpone recovery forever when every relay is unavailable. Once caught
  // up, a later notice starts a fresh relay window instead of staying direct.
  const directFallbackAt = previousNoticeStillPending && existing?.directFallbackAt
    ? new Date(Math.min(existing.directFallbackAt.getTime(), schedule.directFallbackAt.getTime()))
    : schedule.directFallbackAt;
  const inserted = await db.insert(swarmChangeNoticeStates).values({
    originDomain: origin,
    sequence: notice.cursor,
    issuedAt,
    expiresAt,
    noticeJson: JSON.stringify(notice),
    originSignature: entry.signature,
    source: 'remote',
    status: 'pending',
    relayRound: 0,
    relayTargetsJson: '[]',
    attempts: 0,
    nextAttemptAt: now,
    firstSeenAt: now,
    lastReceivedAt: now,
    pullScheduledAt: schedule.pullAt,
    relayHintsJson: JSON.stringify([relay]),
    directFallbackAt,
    lastDelayMs: delayMs,
    lastError: null,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: swarmChangeNoticeStates.originDomain,
    set: {
      sequence: notice.cursor,
      issuedAt,
      expiresAt,
      noticeJson: JSON.stringify(notice),
      originSignature: entry.signature,
      source: 'remote',
      status: 'pending',
      relayRound: 0,
      relayTargetsJson: '[]',
      attempts: 0,
      nextAttemptAt: now,
      firstSeenAt: now,
      lastReceivedAt: now,
      lastForwardedAt: null,
      pullScheduledAt: schedule.pullAt,
      relayHintsJson: JSON.stringify([relay]),
      directFallbackAt,
      lastDelayMs: delayMs,
      lastAttemptAt: null,
      lastError: null,
      updatedAt: now,
    },
    setWhere: lt(swarmChangeNoticeStates.sequence, notice.cursor),
  }).returning({ sequence: swarmChangeNoticeStates.sequence });
  if (inserted.length === 0) return { status: 'duplicate' };
  if (await isNodeBlocked(origin)) {
    await db.update(swarmChangeNoticeStates).set({
      status: 'dead',
      pullScheduledAt: null,
      lastError: 'Notice origin was blocked while accepting the notice',
      updatedAt: new Date(),
    }).where(and(
      eq(swarmChangeNoticeStates.originDomain, origin),
      eq(swarmChangeNoticeStates.sequence, notice.cursor),
    ));
    return { status: 'rejected', reason: 'blocked origin' };
  }

  await scheduleContentPull(origin, notice.cursor, schedule.pullAt, now);
  console.log(`[ChangeNotice] Accepted ${origin} cursor ${notice.cursor} after ${delayMs}ms`);
  return { status: 'accepted', delayMs };
}

async function claimDueNotices(): Promise<Array<typeof swarmChangeNoticeStates.$inferSelect>> {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - PROCESSING_LEASE_MS);
  const blockedDomains = Array.from(await getBlockedNodeDomains());
  const unblockedOrigin = blockedDomains.length > 0
    ? notInArray(swarmChangeNoticeStates.originDomain, blockedDomains)
    : undefined;
  await db.update(swarmChangeNoticeStates).set({
    status: 'retry',
    nextAttemptAt: now,
    updatedAt: now,
  }).where(and(
    eq(swarmChangeNoticeStates.status, 'processing'),
    lte(swarmChangeNoticeStates.lastAttemptAt, staleBefore),
    unblockedOrigin,
  ));
  await db.update(swarmChangeNoticeStates).set({
    status: 'dead',
    lastError: 'Notice expired before relay completed',
    updatedAt: now,
  }).where(and(
    inArray(swarmChangeNoticeStates.status, ['pending', 'processing', 'retry']),
    lte(swarmChangeNoticeStates.expiresAt, now),
  ));

  const due = await db.select().from(swarmChangeNoticeStates).where(and(
    or(
      eq(swarmChangeNoticeStates.status, 'pending'),
      eq(swarmChangeNoticeStates.status, 'retry'),
    ),
    lte(swarmChangeNoticeStates.nextAttemptAt, now),
    gt(swarmChangeNoticeStates.expiresAt, now),
    lt(swarmChangeNoticeStates.relayRound, CHANGE_NOTICE_RELAY_ROUNDS),
    unblockedOrigin,
  )).orderBy(
    asc(swarmChangeNoticeStates.nextAttemptAt),
    asc(swarmChangeNoticeStates.firstSeenAt),
  ).limit(CHANGE_NOTICE_MAX_BATCH);

  const claimed = [];
  for (const row of due) {
    if (await isNodeBlocked(row.originDomain)) continue;
    const result = await db.update(swarmChangeNoticeStates).set({
      status: 'processing',
      lastAttemptAt: now,
      updatedAt: now,
    }).where(and(
      eq(swarmChangeNoticeStates.originDomain, row.originDomain),
      eq(swarmChangeNoticeStates.sequence, row.sequence),
      or(
        eq(swarmChangeNoticeStates.status, 'pending'),
        eq(swarmChangeNoticeStates.status, 'retry'),
      ),
    )).returning({ originDomain: swarmChangeNoticeStates.originDomain });
    if (result.length > 0) claimed.push(row);
  }
  return claimed;
}

async function releaseClaimedNotices(
  rows: Array<typeof swarmChangeNoticeStates.$inferSelect>,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const now = new Date();
  for (const row of rows) {
    await db.update(swarmChangeNoticeStates).set({
      status: 'retry',
      nextAttemptAt: new Date(now.getTime() + CHANGE_NOTICE_ROUND_MS),
      lastError: message.slice(0, 1_000),
      updatedAt: now,
    }).where(and(
      eq(swarmChangeNoticeStates.originDomain, row.originDomain),
      eq(swarmChangeNoticeStates.sequence, row.sequence),
      eq(swarmChangeNoticeStates.status, 'processing'),
    ));
  }
}

async function relayDueNotices(): Promise<{ relayed: number; targets: number }> {
  const claimedRows = await claimDueNotices();
  if (claimedRows.length === 0) return { relayed: 0, targets: 0 };

  const rows: Array<typeof swarmChangeNoticeStates.$inferSelect> = [];
  for (const row of claimedRows) {
    if (!(await isNodeBlocked(row.originDomain))) {
      rows.push(row);
      continue;
    }
    await db.update(swarmChangeNoticeStates).set({
      status: 'dead',
      lastError: 'Notice origin was blocked before relay',
      updatedAt: new Date(),
    }).where(and(
      eq(swarmChangeNoticeStates.originDomain, row.originDomain),
      eq(swarmChangeNoticeStates.sequence, row.sequence),
      eq(swarmChangeNoticeStates.status, 'processing'),
    ));
  }
  if (rows.length === 0) return { relayed: 0, targets: 0 };

  const entries: SignedChangeNotice[] = [];
  try {
    for (const row of rows) {
      entries.push(signedChangeNoticeSchema.parse({
        notice: JSON.parse(row.noticeJson) as unknown,
        signature: row.originSignature,
      }));
    }
  } catch (error) {
    await releaseClaimedNotices(rows, error);
    throw error;
  }

  const ourDomain = getPublicSwarmDomain(process.env.NEXT_PUBLIC_NODE_DOMAIN);
  if (!ourDomain) {
    await releaseClaimedNotices(rows, 'Local node domain is not public');
    return { relayed: 0, targets: 0 };
  }
  const excluded = new Set<string>([ourDomain, ...rows.map((row) => row.originDomain)]);
  for (const row of rows) {
    for (const domain of parsedRelayTargets(row.relayTargetsJson)) excluded.add(domain);
  }
  const targets = await getNodesForChangeNotice(CHANGE_NOTICE_FANOUT, [...excluded]);
  if (targets.length === 0) {
    const now = new Date();
    for (const row of rows) {
      await db.update(swarmChangeNoticeStates).set({
        status: 'delivered',
        updatedAt: now,
      }).where(and(
        eq(swarmChangeNoticeStates.originDomain, row.originDomain),
        eq(swarmChangeNoticeStates.sequence, row.sequence),
        eq(swarmChangeNoticeStates.status, 'processing'),
      ));
    }
    return { relayed: rows.length, targets: 0 };
  }

  const envelope: ChangeNoticeEnvelope = {
    version: 1,
    sender: ourDomain,
    timestamp: new Date().toISOString(),
    notices: entries,
  };
  const privateKey = await getNodePrivateKey();
  const relaySignature = signPayload(envelope, privateKey);
  const body = JSON.stringify({ ...envelope, signature: relaySignature });
  if (Buffer.byteLength(body, 'utf8') > CHANGE_NOTICE_MAX_BODY_BYTES) {
    await releaseClaimedNotices(rows, 'Relay batch exceeded ChangeNoticeV1 byte limit');
    throw new Error('Relay batch exceeded ChangeNoticeV1 byte limit');
  }

  const outcomes = await mapWithConcurrency(targets, CHANGE_NOTICE_FANOUT, async (target) => {
    try {
      const response = await safeFederationRequest(`https://${target.domain}/api/swarm/change-notices`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body,
        timeoutMs: 4_000,
        maxResponseBytes: 16 * 1024,
      });
      return response.status >= 200 && response.status < 300
        ? { domain: target.domain, success: true as const }
        : { domain: target.domain, success: false as const, error: `HTTP ${response.status}` };
    } catch (error) {
      return {
        domain: target.domain,
        success: false as const,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
  const successful = outcomes.filter((outcome) => outcome.success).length;
  const lastError = outcomes.filter((outcome) => !outcome.success)
    .map((outcome) => `${outcome.domain}: ${outcome.error}`)
    .join('; ')
    .slice(0, 1_000) || null;
  const now = new Date();
  for (const row of rows) {
    const nextRound = row.relayRound + 1;
    const contacted = Array.from(new Set([
      ...parsedRelayTargets(row.relayTargetsJson),
      ...targets.map((target) => target.domain),
    ])).slice(0, CHANGE_NOTICE_FANOUT * CHANGE_NOTICE_RELAY_ROUNDS);
    await db.update(swarmChangeNoticeStates).set({
      status: nextRound >= CHANGE_NOTICE_RELAY_ROUNDS ? 'delivered' : 'retry',
      relayRound: nextRound,
      relayTargetsJson: JSON.stringify(contacted),
      attempts: row.attempts + targets.length,
      nextAttemptAt: new Date(now.getTime() + CHANGE_NOTICE_ROUND_MS),
      lastForwardedAt: successful > 0 ? now : row.lastForwardedAt,
      lastError,
      updatedAt: now,
    }).where(and(
      eq(swarmChangeNoticeStates.originDomain, row.originDomain),
      eq(swarmChangeNoticeStates.sequence, row.sequence),
      eq(swarmChangeNoticeStates.status, 'processing'),
    ));
  }
  console.log(`[ChangeNotice] Relayed ${rows.length} cursors to ${targets.length} peers (${successful} successful)`);
  return { relayed: rows.length, targets: targets.length };
}

async function pullNoticePrioritizedOrigins(): Promise<{ pulled: number; failed: number }> {
  const now = new Date();
  const blockedDomains = Array.from(await getBlockedNodeDomains());
  const candidates = await db.select({
    origin: swarmChangeNoticeStates.originDomain,
    cursor: swarmChangeNoticeStates.sequence,
    relayHintsJson: swarmChangeNoticeStates.relayHintsJson,
    directFallbackAt: swarmChangeNoticeStates.directFallbackAt,
  }).from(swarmChangeNoticeStates)
    .innerJoin(
      swarmContentSyncStates,
      eq(swarmContentSyncStates.domain, swarmChangeNoticeStates.originDomain),
    )
    .where(and(
      eq(swarmChangeNoticeStates.source, 'remote'),
      isNotNull(swarmChangeNoticeStates.pullScheduledAt),
      lte(swarmChangeNoticeStates.pullScheduledAt, now),
      sql`coalesce(${swarmContentSyncStates.changeCursor}, -1) < ${swarmChangeNoticeStates.sequence}`,
      ...(blockedDomains.length > 0
        ? [notInArray(swarmChangeNoticeStates.originDomain, blockedDomains)]
        : []),
    ))
    .orderBy(asc(swarmChangeNoticeStates.pullScheduledAt))
    .limit(8);
  const outcomes = await mapWithConcurrency(candidates, 4, async ({
    origin,
    cursor,
    relayHintsJson,
    directFallbackAt,
  }) => (
    syncSwarmContentNoticeOrigin(origin, {
      targetCursor: cursor,
      relayHints: parsedRelayHints(relayHintsJson),
      directFallbackAt,
    })
  ));
  return {
    pulled: outcomes.filter((outcome) => outcome && !outcome.error).length,
    failed: outcomes.filter((outcome) => outcome?.error).length,
  };
}

let activeCycle: Promise<ChangeNoticeCycleResult> | null = null;

async function runChangeNoticeCycle(): Promise<ChangeNoticeCycleResult> {
  const originated = await originateLatestCursor();
  const relay = await relayDueNotices();
  const pulls = await pullNoticePrioritizedOrigins();
  return {
    originated,
    relayed: relay.relayed,
    relayTargets: relay.targets,
    immediatePulls: pulls.pulled,
    pullFailures: pulls.failed,
  };
}

export async function processChangeNoticeCycle(): Promise<ChangeNoticeCycleResult> {
  if (activeCycle) return activeCycle;
  activeCycle = runChangeNoticeCycle();
  try {
    return await activeCycle;
  } finally {
    activeCycle = null;
  }
}

export async function getChangeNoticeHealth() {
  try {
    const [{ count: trackedOrigins }] = await db.select({ count: sql<number>`count(*)` })
      .from(swarmChangeNoticeStates);
    const [{ count: pendingRelays }] = await db.select({ count: sql<number>`count(*)` })
      .from(swarmChangeNoticeStates)
      .where(inArray(swarmChangeNoticeStates.status, ['pending', 'processing', 'retry']));
    const [latestRemote] = await db.select({
      receivedAt: swarmChangeNoticeStates.lastReceivedAt,
      delayMs: swarmChangeNoticeStates.lastDelayMs,
    }).from(swarmChangeNoticeStates)
      .where(eq(swarmChangeNoticeStates.source, 'remote'))
      .orderBy(desc(swarmChangeNoticeStates.lastReceivedAt))
      .limit(1);
    return {
      enabled: true,
      trackedOrigins: Number(trackedOrigins || 0),
      pendingRelays: Number(pendingRelays || 0),
      latestReceivedAt: latestRemote?.receivedAt?.toISOString() || null,
      latestEndToEndMs: latestRemote?.delayMs ?? null,
    };
  } catch (error) {
    return {
      enabled: true,
      error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
    };
  }
}
