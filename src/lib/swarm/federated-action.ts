import crypto from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';

import { db, handleRegistry } from '@/db';
import { withSqliteLockRetry } from '@/lib/db/sqlite-lock-retry';
import {
  verifyActionSignature,
  type SignedAction,
} from '@/lib/auth/verify-signature';
import { canonicalize } from '@/lib/crypto/user-signing';
import { signingPublicKeyFromDid } from '@/lib/crypto/did-key';
import { signedUserActionSchema } from '@/lib/e2ee/protocol';
import { isRateLimited } from '@/lib/rate-limit';
import { localHandleSchema, nodeDomainSchema } from '@/lib/utils/federation';
import { getPublicSwarmDomain, normalizeNodeDomain } from './node-domain';
import { verifySwarmRequestDetailed } from './signature';
import { scheduleInboundFederationReplayCleanup } from './replay';
import {
  consumeFederationNodeActionQuota,
  DEFAULT_FEDERATED_NODE_ACTIONS_PER_WINDOW,
} from './action-quota';

export const FEDERATED_ACTION_PROTOCOL = 'synapsis-federation-action-v2' as const;
export const FEDERATED_ACTION_MAX_AGE_MS = 5 * 60 * 1_000;

const DEVELOPMENT_LOOPBACK_DOMAIN =
  /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i;

export const federationActionContextSchema = z.strictObject({
  protocol: z.literal(FEDERATED_ACTION_PROTOCOL),
  sourceDomain: nodeDomainSchema,
  destinationDomain: nodeDomainSchema,
  method: z.enum(['POST', 'DELETE']),
  path: z.string().min(1).max(200).regex(/^\/api\//),
  issuedAt: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
});

export const federatedActionAuthorizationSchema = z.strictObject({
  federation: federationActionContextSchema,
  userAction: signedUserActionSchema,
});

export type FederationActionContext = z.infer<typeof federationActionContextSchema>;
export type FederatedUserAction = z.infer<typeof signedUserActionSchema>;

/** Exact payload covered by a federated user's signature, without its encoding. */
export function unsignedFederatedUserAction(action: FederatedUserAction) {
  return {
    action: action.action,
    data: action.data,
    did: action.did,
    handle: action.handle,
    ts: action.ts,
    nonce: action.nonce,
  };
}

export interface FederatedActionVerificationSuccess {
  ok: true;
  actorHandle: string;
  sourceDomain: string;
  destinationDomain: string;
  userAction: FederatedUserAction;
  replayId: string;
}

export interface FederatedActionVerificationFailure {
  ok: false;
  error: string;
  status: 400 | 403 | 429 | 503;
}

export type FederatedActionVerificationResult =
  | FederatedActionVerificationSuccess
  | FederatedActionVerificationFailure;

export class FederatedIdentityContinuityError extends Error {
  constructor() {
    super('Federated identity changed');
    this.name = 'FederatedIdentityContinuityError';
  }
}

export interface VerifiedFederatedActorIdentity {
  sourceDomain: string;
  actorHandle: string;
  did: string;
}

export interface PinnedFederatedActorIdentity extends VerifiedFederatedActorIdentity {
  qualifiedHandle: string;
}

type HandleIdentityDatabase = Pick<typeof db, 'insert' | 'select'>;

function developmentFederationDomain(value: string): string | null {
  const normalized = normalizeNodeDomain(value);
  return process.env.NODE_ENV !== 'production'
    && DEVELOPMENT_LOOPBACK_DOMAIN.test(normalized)
    ? normalized
    : null;
}

export function federationActionDomain(value: string | null | undefined): string | null {
  if (!value) return null;
  return getPublicSwarmDomain(value) ?? developmentFederationDomain(value);
}

/**
 * Permanently bind a verified remote handle on its authoritative node to the
 * self-certifying DID that signed the action.
 *
 * Directory rows are explicitly unverified hints. The conditional upsert may
 * replace one with the first valid signed identity, but it can never update a
 * verified row. Concurrent first-use requests therefore converge on exactly
 * one DID, and every loser succeeds only when it signed with that same DID.
 */
export async function pinVerifiedFederatedActorIdentity(
  input: VerifiedFederatedActorIdentity,
  database: HandleIdentityDatabase = db,
): Promise<PinnedFederatedActorIdentity> {
  const sourceDomain = federationActionDomain(input.sourceDomain);
  const actorHandle = input.actorHandle.trim().replace(/^@/, '').toLowerCase();
  const parsedHandle = localHandleSchema.safeParse(actorHandle);
  if (!sourceDomain || !parsedHandle.success || !input.did) {
    throw new FederatedIdentityContinuityError();
  }

  const qualifiedHandle = `${parsedHandle.data}@${sourceDomain}`;
  const [existingDidOwner] = await withSqliteLockRetry(() => (
    database.select({
      handle: handleRegistry.handle,
      deletedAt: handleRegistry.deletedAt,
    })
      .from(handleRegistry)
      .where(and(
        eq(handleRegistry.nodeDomain, sourceDomain),
        eq(handleRegistry.did, input.did),
        eq(handleRegistry.identityVerified, true),
      ))
      .limit(1)
  ));
  if (existingDidOwner?.deletedAt || (existingDidOwner && existingDidOwner.handle !== qualifiedHandle)) {
    throw new FederatedIdentityContinuityError();
  }

  let pinned: {
    did: string;
    nodeDomain: string;
    identityVerified: boolean;
    deletedAt: Date | null;
  } | undefined;
  try {
    [pinned] = await withSqliteLockRetry(() => (
      database.insert(handleRegistry).values({
        handle: qualifiedHandle,
        did: input.did,
        nodeDomain: sourceDomain,
        identityVerified: true,
      }).onConflictDoUpdate({
        target: handleRegistry.handle,
        set: {
          did: input.did,
          nodeDomain: sourceDomain,
          identityVerified: true,
          updatedAt: new Date(),
        },
        setWhere: and(
          eq(handleRegistry.identityVerified, false),
          isNull(handleRegistry.deletedAt),
        ),
      }).returning({
        did: handleRegistry.did,
        nodeDomain: handleRegistry.nodeDomain,
        identityVerified: handleRegistry.identityVerified,
        deletedAt: handleRegistry.deletedAt,
      })
    ));
  } catch (error) {
    if (error instanceof Error
      && /(?:handle_registry_verified_node_did_unique_idx|UNIQUE constraint failed: handle_registry\.node_domain, handle_registry\.did)/i.test(error.message)) {
      throw new FederatedIdentityContinuityError();
    }
    throw error;
  }

  const [identity] = pinned ? [pinned] : await withSqliteLockRetry(() => (
    database.select({
      did: handleRegistry.did,
      nodeDomain: handleRegistry.nodeDomain,
      identityVerified: handleRegistry.identityVerified,
      deletedAt: handleRegistry.deletedAt,
    }).from(handleRegistry).where(eq(handleRegistry.handle, qualifiedHandle)).limit(1)
  ));
  if (!identity
    || identity.deletedAt
    || !identity.identityVerified
    || identity.did !== input.did
    || federationActionDomain(identity.nodeDomain) !== sourceDomain) {
    throw new FederatedIdentityContinuityError();
  }

  return {
    sourceDomain,
    actorHandle: parsedHandle.data,
    qualifiedHandle,
    did: input.did,
  };
}

export function createFederationActionContext(input: {
  destinationDomain: string;
  method: 'POST' | 'DELETE';
  path: string;
  now?: number;
}): FederationActionContext {
  const sourceDomain = federationActionDomain(process.env.NEXT_PUBLIC_NODE_DOMAIN);
  const destinationDomain = federationActionDomain(input.destinationDomain);
  if (!sourceDomain || !destinationDomain) {
    throw new Error('Federation action requires configured public source and destination nodes');
  }

  const now = input.now ?? Date.now();
  return federationActionContextSchema.parse({
    protocol: FEDERATED_ACTION_PROTOCOL,
    sourceDomain,
    destinationDomain,
    method: input.method,
    path: input.path,
    issuedAt: now,
    expiresAt: now + FEDERATED_ACTION_MAX_AGE_MS,
  });
}

function fail(
  status: FederatedActionVerificationFailure['status'],
  error: string,
): FederatedActionVerificationFailure {
  return { ok: false, status, error };
}

export function federatedActionFailureInit(
  failure: FederatedActionVerificationFailure,
): ResponseInit {
  return {
    status: failure.status,
    headers: failure.status === 429 || failure.status === 503
      ? { 'Retry-After': failure.status === 429 ? '60' : '1' }
      : undefined,
  };
}

/**
 * Verify both layers of a state-changing federation request:
 *
 * 1. The source node signed an envelope for this exact destination and route.
 * 2. A self-certifying user DID signed the action represented by that envelope.
 *
 * Callers still validate action-specific `userAction.data` bindings and claim
 * `replayId` transactionally with the resulting state change.
 */
export async function verifyFederatedUserAction(input: {
  payload: {
    federation: FederationActionContext;
    userAction: FederatedUserAction;
    [key: string]: unknown;
  };
  nodeSignature: string;
  sourceDomain: string;
  expectedMethod: 'POST' | 'DELETE';
  expectedPath: string;
  expectedAction: string;
  actorHandle: string;
  replayBinding: unknown;
  maxUserActionAgeMs?: number;
  maxActionsPerMinute?: number;
  maxNodeActionsPerMinute?: number;
  now?: number;
}): Promise<FederatedActionVerificationResult> {
  const now = input.now ?? Date.now();
  const context = federationActionContextSchema.safeParse(input.payload.federation);
  const userAction = signedUserActionSchema.safeParse(input.payload.userAction);
  if (!context.success || !userAction.success) {
    return fail(400, 'Invalid federation authorization envelope');
  }

  const sourceDomain = federationActionDomain(input.sourceDomain);
  const contextSource = federationActionDomain(context.data.sourceDomain);
  const contextDestination = federationActionDomain(context.data.destinationDomain);
  const localDomain = federationActionDomain(process.env.NEXT_PUBLIC_NODE_DOMAIN);
  if (!sourceDomain || !contextSource || sourceDomain !== contextSource) {
    return fail(403, 'Federation source mismatch');
  }
  if (!localDomain) {
    return fail(503, 'This node is not configured for authenticated federation actions');
  }
  if (!contextDestination || contextDestination !== localDomain) {
    return fail(403, 'Federation destination mismatch');
  }
  if (context.data.method !== input.expectedMethod || context.data.path !== input.expectedPath) {
    return fail(403, 'Federation route mismatch');
  }
  if (Math.abs(now - context.data.issuedAt) > FEDERATED_ACTION_MAX_AGE_MS
    || context.data.expiresAt < now
    || context.data.expiresAt < context.data.issuedAt
    || context.data.expiresAt - context.data.issuedAt > FEDERATED_ACTION_MAX_AGE_MS) {
    return fail(400, 'Federation envelope is stale');
  }

  const nodeVerification = await verifySwarmRequestDetailed(
    input.payload,
    input.nodeSignature,
    sourceDomain,
  );
  if (!nodeVerification.ok) {
    if (nodeVerification.reason === 'overloaded') {
      return fail(
        nodeVerification.status === 429 ? 429 : 503,
        'Node signature verification is temporarily overloaded',
      );
    }
    if (nodeVerification.reason === 'identity-unavailable') {
      return fail(503, 'Source node identity is temporarily unavailable');
    }
    return fail(403, 'Invalid node signature');
  }

  // Only authenticated nodes can consume the durable shared quota. Charging
  // before user-proof acceptance also prevents a valid hostile node from
  // bypassing the node-wide limit with invalid or throwaway user identities.
  try {
    const nodeQuota = await consumeFederationNodeActionQuota({
      sourceDomain,
      limit: input.maxNodeActionsPerMinute
        ?? DEFAULT_FEDERATED_NODE_ACTIONS_PER_WINDOW,
      now,
    });
    if (!nodeQuota.allowed) {
      return fail(429, 'Federation node is sending actions too quickly');
    }
  } catch (error) {
    console.error('[Swarm] Durable federation action quota failed:', error);
    return fail(503, 'Federation action quota is unavailable');
  }

  const action = userAction.data;
  const actorHandle = input.actorHandle.trim().replace(/^@/, '').toLowerCase();
  if (action.action !== input.expectedAction
    || action.handle.trim().replace(/^@/, '').toLowerCase() !== actorHandle) {
    return fail(403, 'Federated user action does not match its actor');
  }

  const maxUserActionAgeMs = input.maxUserActionAgeMs ?? FEDERATED_ACTION_MAX_AGE_MS;
  if (action.ts - now > FEDERATED_ACTION_MAX_AGE_MS || now - action.ts > maxUserActionAgeMs) {
    return fail(400, 'Federated user action is stale');
  }

  // A node-provided profile key is not sufficient under a hostile-node threat
  // model. The signing key must be encoded in the DID itself.
  const userPublicKey = signingPublicKeyFromDid(action.did);
  if (!userPublicKey) {
    return fail(403, 'Federated actions require a self-certifying user DID');
  }
  if (!await verifyActionSignature(action as SignedAction<unknown>, userPublicKey)) {
    return fail(403, 'Invalid user signature');
  }

  // Charge the source node as well as the user. Otherwise a hostile peer can
  // mint unlimited throwaway DIDs to bypass every per-user bucket.
  if (isRateLimited(
    `federated-node-action:${sourceDomain}`,
    input.maxNodeActionsPerMinute ?? DEFAULT_FEDERATED_NODE_ACTIONS_PER_WINDOW,
    60 * 1_000,
  ) || isRateLimited(
    `federated-user-action:${sourceDomain}:${action.did}:${action.action}`,
    input.maxActionsPerMinute ?? 120,
    60 * 1_000,
  )) {
    return fail(429, 'Federated user is sending actions too quickly');
  }

  const replayId = crypto.createHash('sha256').update(canonicalize({
    protocol: FEDERATED_ACTION_PROTOCOL,
    sourceDomain,
    destinationDomain: localDomain,
    method: input.expectedMethod,
    path: input.expectedPath,
    userAction: unsignedFederatedUserAction(action),
    binding: input.replayBinding,
  })).digest('hex');

  scheduleInboundFederationReplayCleanup();

  return {
    ok: true,
    actorHandle,
    sourceDomain,
    destinationDomain: localDomain,
    userAction: action,
    replayId,
  };
}
