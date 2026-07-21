import {
  db,
  swarmChangeBundles,
} from '@/db';
import type { SwarmPostChange } from '@/app/api/swarm/timeline/route';
import {
  and,
  asc,
  desc,
  eq,
  gt,
  lt,
  lte,
  sql,
} from 'drizzle-orm';
import { z } from 'zod';
import { getPublicSwarmDomain, isPublicSwarmDomain } from './node-domain';
import { parseRemoteTimelineResponse } from './remote-timeline-payload';
import { getTrustedSwarmReadPeerPublicKey } from './registry';
import { getNodePrivateKey, signPayload, verifySignature } from './signature';
import { isNodeBlocked } from './node-blocklist';

export const CHANGE_BUNDLE_LIFETIME_MS = 5 * 60_000;
export const CHANGE_BUNDLE_CLOCK_SKEW_MS = 30_000;
export const CHANGE_BUNDLE_MAX_BYTES = 1024 * 1024;
export const CHANGE_BUNDLE_MAX_CHANGES = 50;
export const CHANGE_BUNDLE_MAX_SIGNATURE_BYTES = 2_048;
const MAX_CACHED_BUNDLES_PER_ORIGIN = 32;
const MAX_CHANGE_BUNDLE_CACHE_BYTES = 256 * 1024 * 1024;

export const changeBundleV1Schema = z.strictObject({
  type: z.literal('ChangeBundle'),
  version: z.literal(1),
  origin: z.string().min(1).max(253),
  fromCursor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  toCursor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  changes: z.array(z.unknown()).max(CHANGE_BUNDLE_MAX_CHANGES),
  hasMoreChanges: z.boolean(),
  nodeIsNsfw: z.boolean(),
});

export const signedChangeBundleSchema = z.strictObject({
  bundle: changeBundleV1Schema,
  signature: z.string().min(1).max(CHANGE_BUNDLE_MAX_SIGNATURE_BYTES),
});

export type ChangeBundleV1 = z.infer<typeof changeBundleV1Schema>;
export type SignedChangeBundle = z.infer<typeof signedChangeBundleSchema>;

export interface VerifiedChangeBundle {
  signed: SignedChangeBundle;
  origin: string;
  fromCursor: number;
  toCursor: number;
  issuedAt: Date;
  expiresAt: Date;
  changes: SwarmPostChange[];
  hasMoreChanges: boolean;
  nodeIsNsfw: boolean;
}

export function validateChangeBundleTiming(
  bundle: ChangeBundleV1,
  nowMs = Date.now(),
): string | null {
  const issuedAt = Date.parse(bundle.issuedAt);
  const expiresAt = Date.parse(bundle.expiresAt);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) return 'invalid timestamp';
  if (issuedAt > nowMs + CHANGE_BUNDLE_CLOCK_SKEW_MS) return 'issued in the future';
  if (expiresAt <= issuedAt || expiresAt - issuedAt > CHANGE_BUNDLE_LIFETIME_MS) {
    return 'invalid lifetime';
  }
  if (expiresAt <= nowMs) return 'expired';
  return null;
}

function validateBundleContents(
  signed: SignedChangeBundle,
  expectedOriginInput: string,
): Omit<VerifiedChangeBundle, 'signed' | 'issuedAt' | 'expiresAt'> {
  const bundle = signed.bundle;
  const origin = getPublicSwarmDomain(bundle.origin);
  const expectedOrigin = getPublicSwarmDomain(expectedOriginInput);
  if (!origin || !expectedOrigin || origin !== bundle.origin || origin !== expectedOrigin
    || !isPublicSwarmDomain(origin)) {
    throw new Error('Change bundle origin mismatch');
  }
  const timingError = validateChangeBundleTiming(bundle);
  if (timingError) throw new Error(`Change bundle ${timingError}`);
  if (bundle.toCursor < bundle.fromCursor) {
    throw new Error('Change bundle cursor range is invalid');
  }

  const parsed = parseRemoteTimelineResponse({
    posts: [],
    changes: bundle.changes,
    changeCursor: bundle.toCursor,
    hasMoreChanges: bundle.hasMoreChanges,
    nodeDomain: bundle.origin,
    nodeIsNsfw: bundle.nodeIsNsfw,
    timestamp: bundle.issuedAt,
  }, origin);
  let previousSequence = bundle.fromCursor;
  for (const change of parsed.changes) {
    if (change.sequence <= previousSequence || change.sequence > bundle.toCursor) {
      throw new Error('Change bundle sequence is outside its signed cursor range');
    }
    previousSequence = change.sequence;
  }
  if (bundle.hasMoreChanges
    && (parsed.changes.length !== CHANGE_BUNDLE_MAX_CHANGES
      || previousSequence !== bundle.toCursor)) {
    throw new Error('Paginated change bundle boundary is invalid');
  }

  return {
    origin,
    fromCursor: bundle.fromCursor,
    toCursor: bundle.toCursor,
    changes: parsed.changes,
    hasMoreChanges: bundle.hasMoreChanges,
    nodeIsNsfw: bundle.nodeIsNsfw,
  };
}

/** Create the immutable origin-signed page included in an incremental timeline response. */
export async function createSignedChangeBundle(input: {
  origin: string;
  fromCursor: number;
  toCursor: number;
  changes: SwarmPostChange[];
  hasMoreChanges: boolean;
  nodeIsNsfw: boolean;
  now?: Date;
}): Promise<SignedChangeBundle> {
  const origin = getPublicSwarmDomain(input.origin);
  if (!origin || origin !== input.origin) throw new Error('Cannot sign a bundle for an invalid origin');
  const now = input.now ?? new Date();
  const bundle = changeBundleV1Schema.parse({
    type: 'ChangeBundle',
    version: 1,
    origin,
    fromCursor: input.fromCursor,
    toCursor: input.toCursor,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + CHANGE_BUNDLE_LIFETIME_MS).toISOString(),
    changes: input.changes,
    hasMoreChanges: input.hasMoreChanges,
    nodeIsNsfw: input.nodeIsNsfw,
  });
  // Validate locally before signing so a route regression cannot create a
  // structurally valid signature over an unusable page.
  validateBundleContents({ bundle, signature: 'pending' }, origin);
  return {
    bundle,
    signature: signPayload(bundle, await getNodePrivateKey()),
  };
}

/** Verify origin authority independently of whichever untrusted relay supplied the page. */
export async function verifySignedChangeBundle(
  value: unknown,
  expectedOrigin: string,
): Promise<VerifiedChangeBundle> {
  const signed = signedChangeBundleSchema.parse(value);
  const contents = validateBundleContents(signed, expectedOrigin);
  if (await isNodeBlocked(contents.origin)) {
    throw new Error('Change bundle origin is blocked');
  }
  const publicKey = await getTrustedSwarmReadPeerPublicKey(contents.origin);
  if (!publicKey || !verifySignature(signed.bundle, signed.signature, publicKey)) {
    throw new Error('Invalid change bundle origin signature');
  }
  return {
    signed,
    ...contents,
    issuedAt: new Date(signed.bundle.issuedAt),
    expiresAt: new Date(signed.bundle.expiresAt),
  };
}

/** Persist only a fully verified bundle, then keep the short-lived cache bounded. */
export async function cacheVerifiedChangeBundle(bundle: VerifiedChangeBundle): Promise<void> {
  if (await isNodeBlocked(bundle.origin)) {
    throw new Error('Cannot cache a change bundle from a blocked origin');
  }
  const bundleJson = JSON.stringify(bundle.signed.bundle);
  if (Buffer.byteLength(bundleJson, 'utf8') > CHANGE_BUNDLE_MAX_BYTES) {
    throw new Error('Change bundle exceeds cache byte limit');
  }
  const now = new Date();
  await db.insert(swarmChangeBundles).values({
    originDomain: bundle.origin,
    fromCursor: bundle.fromCursor,
    toCursor: bundle.toCursor,
    issuedAt: bundle.issuedAt,
    expiresAt: bundle.expiresAt,
    bundleJson,
    originSignature: bundle.signed.signature,
    cachedAt: now,
    lastAccessedAt: now,
  }).onConflictDoUpdate({
    target: [
      swarmChangeBundles.originDomain,
      swarmChangeBundles.fromCursor,
      swarmChangeBundles.toCursor,
    ],
    set: {
      issuedAt: bundle.issuedAt,
      expiresAt: bundle.expiresAt,
      bundleJson,
      originSignature: bundle.signed.signature,
      cachedAt: now,
      lastAccessedAt: now,
    },
  });
  if (await isNodeBlocked(bundle.origin)) {
    await db.delete(swarmChangeBundles).where(eq(swarmChangeBundles.originDomain, bundle.origin));
    throw new Error('Change bundle origin was blocked while caching');
  }
  await db.delete(swarmChangeBundles).where(lt(swarmChangeBundles.expiresAt, now));

  const overflow = await db.select({
    fromCursor: swarmChangeBundles.fromCursor,
    toCursor: swarmChangeBundles.toCursor,
  }).from(swarmChangeBundles)
    .where(eq(swarmChangeBundles.originDomain, bundle.origin))
    .orderBy(desc(swarmChangeBundles.cachedAt), desc(swarmChangeBundles.toCursor))
    .limit(100)
    .offset(MAX_CACHED_BUNDLES_PER_ORIGIN);
  for (const row of overflow) {
    await db.delete(swarmChangeBundles).where(and(
      eq(swarmChangeBundles.originDomain, bundle.origin),
      eq(swarmChangeBundles.fromCursor, row.fromCursor),
      eq(swarmChangeBundles.toCursor, row.toCursor),
    ));
  }

  const [{ bytes: totalBytes }] = await db.select({
    bytes: sql<number>`coalesce(sum(length(${swarmChangeBundles.bundleJson})), 0)`,
  }).from(swarmChangeBundles);
  let bytesToRemove = Number(totalBytes || 0) - MAX_CHANGE_BUNDLE_CACHE_BYTES;
  if (bytesToRemove > 0) {
    const oldest = await db.select({
      originDomain: swarmChangeBundles.originDomain,
      fromCursor: swarmChangeBundles.fromCursor,
      toCursor: swarmChangeBundles.toCursor,
      bytes: sql<number>`length(${swarmChangeBundles.bundleJson})`,
    }).from(swarmChangeBundles)
      .orderBy(asc(swarmChangeBundles.lastAccessedAt), asc(swarmChangeBundles.cachedAt))
      .limit(100);
    for (const row of oldest) {
      await db.delete(swarmChangeBundles).where(and(
        eq(swarmChangeBundles.originDomain, row.originDomain),
        eq(swarmChangeBundles.fromCursor, row.fromCursor),
        eq(swarmChangeBundles.toCursor, row.toCursor),
      ));
      bytesToRemove -= Number(row.bytes || 0);
      if (bytesToRemove <= 0) break;
    }
  }
}

/** Return the best cached page covering a receiver cursor, re-verifying before use or service. */
export async function getCachedVerifiedChangeBundle(
  originInput: string,
  afterCursor: number,
): Promise<VerifiedChangeBundle | null> {
  const origin = getPublicSwarmDomain(originInput);
  if (!origin || origin !== originInput || await isNodeBlocked(origin)) return null;
  const now = new Date();
  const rows = await db.select().from(swarmChangeBundles).where(and(
    eq(swarmChangeBundles.originDomain, origin),
    lte(swarmChangeBundles.fromCursor, afterCursor),
    gt(swarmChangeBundles.toCursor, afterCursor),
    gt(swarmChangeBundles.expiresAt, now),
  )).orderBy(
    desc(swarmChangeBundles.toCursor),
    desc(swarmChangeBundles.fromCursor),
  ).limit(3);

  for (const row of rows) {
    try {
      const verified = await verifySignedChangeBundle({
        bundle: JSON.parse(row.bundleJson) as unknown,
        signature: row.originSignature,
      }, origin);
      await db.update(swarmChangeBundles).set({ lastAccessedAt: now }).where(and(
        eq(swarmChangeBundles.originDomain, row.originDomain),
        eq(swarmChangeBundles.fromCursor, row.fromCursor),
        eq(swarmChangeBundles.toCursor, row.toCursor),
      ));
      return verified;
    } catch {
      await db.delete(swarmChangeBundles).where(and(
        eq(swarmChangeBundles.originDomain, row.originDomain),
        eq(swarmChangeBundles.fromCursor, row.fromCursor),
        eq(swarmChangeBundles.toCursor, row.toCursor),
      ));
    }
  }
  return null;
}
