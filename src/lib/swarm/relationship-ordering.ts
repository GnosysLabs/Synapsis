import crypto from 'node:crypto';
import { and, eq, lt, or } from 'drizzle-orm';

import { swarmRelationshipStates } from '@/db/schema';
import { canonicalize } from '@/lib/crypto/user-signing';
import {
  signedUserActionSchema,
  type SignedUserAction,
} from '@/lib/e2ee/protocol';
import {
  federationActionDomain,
  unsignedFederatedUserAction,
} from './federated-action';

export const FEDERATED_RELATIONSHIP_ORDERING_PROTOCOL =
  'synapsis-federated-relationship-ordering-v1' as const;

export const FEDERATED_RELATIONSHIP_ACTIONS = {
  like: { present: 'like', absent: 'unlike' },
  follow: { present: 'follow', absent: 'unfollow' },
  repost: { present: 'repost', absent: 'unrepost' },
} as const;

export type FederatedRelationshipKind =
  keyof typeof FEDERATED_RELATIONSHIP_ACTIONS;

type SynapsisDatabase = typeof import('@/db').db;
export type FederatedRelationshipTransaction = Parameters<
  Parameters<SynapsisDatabase['transaction']>[0]
>[0];

export interface FederatedRelationshipStateInput {
  sourceDomain: string;
  relationshipKind: FederatedRelationshipKind;
  target: string;
  state: boolean;
  userAction: SignedUserAction;
}

interface CanonicalFederatedRelationshipState {
  sourceDomain: string;
  actorDid: string;
  relationshipKind: FederatedRelationshipKind;
  target: string;
  state: boolean;
  actionTs: number;
  tieBreaker: string;
}

export type FederatedRelationshipStateResult<T> =
  | (CanonicalFederatedRelationshipState & {
    applied: true;
    value: T;
  })
  | {
    applied: false;
    reason: 'duplicate' | 'stale';
    currentState: boolean;
    currentActionTs: number;
    currentTieBreaker: string;
  };

function isFederatedRelationshipKind(
  value: string,
): value is FederatedRelationshipKind {
  return Object.hasOwn(FEDERATED_RELATIONSHIP_ACTIONS, value);
}

/** Canonical identity used by the durable composite relationship key. */
export function canonicalFederatedRelationshipTarget(target: string): string {
  const canonical = target.trim().replace(/^@/, '').normalize('NFC').toLowerCase();
  if (!canonical || canonical.length > 2_048) {
    throw new Error('Federated relationship target is invalid');
  }
  return canonical;
}

/**
 * Hash the unsigned action together with its canonical relationship
 * identity. Equal timestamps therefore converge on the same winner regardless
 * of delivery order, without trusting a node-provided interaction ID.
 */
export function federatedRelationshipTieBreaker(
  input: FederatedRelationshipStateInput,
): string {
  const relationshipKind = input.relationshipKind as string;
  if (!isFederatedRelationshipKind(relationshipKind)) {
    throw new Error('Federated relationship kind is invalid');
  }
  if (typeof input.state !== 'boolean') {
    throw new Error('Federated relationship state is invalid');
  }

  const sourceDomain = federationActionDomain(input.sourceDomain);
  if (!sourceDomain) {
    throw new Error('Federated relationship source is invalid');
  }

  const userAction = signedUserActionSchema.parse(input.userAction);
  const expectedAction = FEDERATED_RELATIONSHIP_ACTIONS[relationshipKind][
    input.state ? 'present' : 'absent'
  ];
  if (userAction.action !== expectedAction) {
    throw new Error(
      `Signed ${userAction.action} action cannot set ${relationshipKind} state`,
    );
  }

  return crypto.createHash('sha256').update(canonicalize({
    protocol: FEDERATED_RELATIONSHIP_ORDERING_PROTOCOL,
    sourceDomain,
    actorDid: userAction.did,
    relationshipKind,
    target: canonicalFederatedRelationshipTarget(input.target),
    state: input.state,
    userAction: unsignedFederatedUserAction(userAction),
  })).digest('hex');
}

function canonicalRelationshipState(
  input: FederatedRelationshipStateInput,
): CanonicalFederatedRelationshipState {
  const relationshipKind = input.relationshipKind as string;
  if (!isFederatedRelationshipKind(relationshipKind)) {
    throw new Error('Federated relationship kind is invalid');
  }

  const userAction = signedUserActionSchema.parse(input.userAction);
  const sourceDomain = federationActionDomain(input.sourceDomain);
  if (!sourceDomain) {
    throw new Error('Federated relationship source is invalid');
  }

  return {
    sourceDomain,
    actorDid: userAction.did,
    relationshipKind,
    target: canonicalFederatedRelationshipTarget(input.target),
    state: input.state,
    actionTs: userAction.ts,
    tieBreaker: federatedRelationshipTieBreaker({ ...input, userAction }),
  };
}

/**
 * Atomically advance a reversible relationship and apply its materialized
 * state only when the signed action wins the `(timestamp, tie-breaker)` order.
 *
 * This must be called with the same database transaction used by `applyState`.
 * If `applyState` throws, the ordering record rolls back with the mutation.
 */
export async function applyOrderedFederatedRelationshipState<T>(
  tx: FederatedRelationshipTransaction,
  input: FederatedRelationshipStateInput,
  applyState: (state: boolean) => T | Promise<T>,
): Promise<FederatedRelationshipStateResult<T>> {
  const next = canonicalRelationshipState(input);
  const updatedAt = new Date();

  const accepted = await tx.insert(swarmRelationshipStates).values({
    sourceDomain: next.sourceDomain,
    actorDid: next.actorDid,
    relationshipKind: next.relationshipKind,
    target: next.target,
    lastActionTs: next.actionTs,
    lastActionTieBreaker: next.tieBreaker,
    state: next.state,
    updatedAt,
  }).onConflictDoUpdate({
    target: [
      swarmRelationshipStates.sourceDomain,
      swarmRelationshipStates.actorDid,
      swarmRelationshipStates.relationshipKind,
      swarmRelationshipStates.target,
    ],
    set: {
      lastActionTs: next.actionTs,
      lastActionTieBreaker: next.tieBreaker,
      state: next.state,
      updatedAt,
    },
    setWhere: or(
      lt(swarmRelationshipStates.lastActionTs, next.actionTs),
      and(
        eq(swarmRelationshipStates.lastActionTs, next.actionTs),
        lt(swarmRelationshipStates.lastActionTieBreaker, next.tieBreaker),
      ),
    ),
  }).returning({ id: swarmRelationshipStates.id });

  if (accepted.length === 1) {
    return {
      applied: true,
      ...next,
      value: await applyState(next.state),
    };
  }

  const [current] = await tx.select({
    state: swarmRelationshipStates.state,
    actionTs: swarmRelationshipStates.lastActionTs,
    tieBreaker: swarmRelationshipStates.lastActionTieBreaker,
  }).from(swarmRelationshipStates).where(and(
    eq(swarmRelationshipStates.sourceDomain, next.sourceDomain),
    eq(swarmRelationshipStates.actorDid, next.actorDid),
    eq(swarmRelationshipStates.relationshipKind, next.relationshipKind),
    eq(swarmRelationshipStates.target, next.target),
  )).limit(1);

  if (!current) {
    throw new Error('Federated relationship ordering state disappeared');
  }

  return {
    applied: false,
    reason: current.actionTs === next.actionTs
      && current.tieBreaker === next.tieBreaker
      ? 'duplicate'
      : 'stale',
    currentState: current.state,
    currentActionTs: current.actionTs,
    currentTieBreaker: current.tieBreaker,
  };
}
