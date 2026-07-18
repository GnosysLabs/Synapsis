import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Database } from '@tursodatabase/database';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/tursodatabase/database';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { relations } from '@/db/relations';
import type { SignedUserAction } from '@/lib/e2ee/protocol';
import {
  applyOrderedFederatedRelationshipState,
  federatedRelationshipTieBreaker,
  type FederatedRelationshipStateInput,
} from './relationship-ordering';

const NOW = 1_750_000_000_000;
const TARGET = 'swarm:local.social:550e8400-e29b-41d4-a716-446655440000';
const migrationPath = resolve(
  'drizzle/20260718220000_federated_relationship_ordering/migration.sql',
);

function testDatabase(client: Database) {
  return drizzle({ client, relations });
}

type TestDatabase = ReturnType<typeof testDatabase>;

function signedAction({
  action,
  ts = NOW,
  nonce,
  did = 'did:key:zAliceSigningKey',
}: {
  action: SignedUserAction['action'];
  ts?: number;
  nonce: string;
  did?: string;
}): SignedUserAction {
  return {
    action,
    data: { postId: TARGET },
    did,
    handle: 'alice',
    ts,
    nonce,
    sig: `signature_${nonce}`,
  };
}

function likeState({
  state,
  ts = NOW,
  nonce,
  sourceDomain = 'remote.social',
  target = TARGET,
  did,
}: {
  state: boolean;
  ts?: number;
  nonce: string;
  sourceDomain?: string;
  target?: string;
  did?: string;
}): FederatedRelationshipStateInput {
  return {
    sourceDomain,
    relationshipKind: 'like',
    target,
    state,
    userAction: signedAction({
      action: state ? 'like' : 'unlike',
      ts,
      nonce,
      did,
    }),
  };
}

describe('ordered federated relationship state', () => {
  let client: Database;
  let database: TestDatabase;

  beforeEach(async () => {
    client = new Database(':memory:');
    await client.connect();
    const migration = readFileSync(migrationPath, 'utf8')
      .replaceAll('--> statement-breakpoint', '');
    await client.exec(migration);
    await client.exec(`
      CREATE TABLE relationship_effects (
        id text PRIMARY KEY NOT NULL,
        state integer NOT NULL
      );
    `);
    database = testDatabase(client);
  });

  afterEach(async () => {
    await client.close();
  });

  async function apply<T>(
    input: FederatedRelationshipStateInput,
    callback: (state: boolean) => T | Promise<T>,
  ) {
    return database.transaction(async (tx) => (
      applyOrderedFederatedRelationshipState(tx, input, callback)
    ));
  }

  it('materializes an exact signed action once and treats its replay as idempotent', async () => {
    const materialize = vi.fn(async () => 'materialized');
    const input = likeState({
      state: true,
      nonce: 'same_action_nonce_0001',
      sourceDomain: 'HTTPS://REMOTE.SOCIAL/delivery',
      target: `  ${TARGET.toUpperCase()}  `,
    });

    const first = await apply(input, materialize);
    const duplicate = await apply({
      ...input,
      sourceDomain: 'remote.social',
      target: TARGET,
    }, materialize);

    expect(first).toMatchObject({
      applied: true,
      sourceDomain: 'remote.social',
      target: TARGET,
      state: true,
      value: 'materialized',
    });
    expect(duplicate).toMatchObject({
      applied: false,
      reason: 'duplicate',
      currentState: true,
    });
    expect(materialize).toHaveBeenCalledOnce();
    expect(await client.get(
      'SELECT COUNT(*) AS count FROM swarm_relationship_states',
    )).toEqual({ count: 1 });
  });

  it('does not resurrect older state when a node delivers unlike before like', async () => {
    const materializedStates: boolean[] = [];
    const newerUnlike = likeState({
      state: false,
      ts: NOW + 1_000,
      nonce: 'newer_unlike_nonce_01',
    });
    const olderLike = likeState({
      state: true,
      ts: NOW,
      nonce: 'older_like_nonce_0001',
    });

    expect(await apply(newerUnlike, state => materializedStates.push(state)))
      .toMatchObject({ applied: true, state: false });
    expect(await apply(olderLike, state => materializedStates.push(state)))
      .toMatchObject({ applied: false, reason: 'stale', currentState: false });

    expect(materializedStates).toEqual([false]);
    expect(await client.get(
      'SELECT state, last_action_ts AS actionTs FROM swarm_relationship_states',
    )).toEqual({ state: 0, actionTs: NOW + 1_000 });
  });

  it('uses the deterministic tie-breaker to converge at equal timestamps', async () => {
    const present = likeState({
      state: true,
      nonce: 'equal_time_like_nonce_01',
    });
    const absent = likeState({
      state: false,
      nonce: 'equal_time_unlike_nonce_1',
    });
    const presentTie = federatedRelationshipTieBreaker(present);
    const absentTie = federatedRelationshipTieBreaker(absent);
    const [lower, higher] = presentTie < absentTie
      ? [present, absent]
      : [absent, present];
    const winningTie = presentTie < absentTie ? absentTie : presentTie;
    const winningState = higher.state;

    const firstDeliveryStates: boolean[] = [];
    await apply(lower, state => firstDeliveryStates.push(state));
    await apply(higher, state => firstDeliveryStates.push(state));
    const firstWinner = await client.get(
      'SELECT state, last_action_tie_breaker AS tieBreaker FROM swarm_relationship_states',
    );

    await client.run('DELETE FROM swarm_relationship_states');

    const reverseDeliveryStates: boolean[] = [];
    await apply(higher, state => reverseDeliveryStates.push(state));
    const ignoredLower = await apply(lower, state => reverseDeliveryStates.push(state));
    const reverseWinner = await client.get(
      'SELECT state, last_action_tie_breaker AS tieBreaker FROM swarm_relationship_states',
    );

    expect(ignoredLower).toMatchObject({ applied: false, reason: 'stale' });
    expect(firstWinner).toEqual({ state: winningState ? 1 : 0, tieBreaker: winningTie });
    expect(reverseWinner).toEqual(firstWinner);
    expect(firstDeliveryStates).toEqual([lower.state, winningState]);
    expect(reverseDeliveryStates).toEqual([winningState]);
  });

  it('does not include signature representation in the ordering tie-breaker', () => {
    const original = likeState({
      state: true,
      nonce: 'same_unsigned_action_01',
    });
    const remalleated = {
      ...original,
      userAction: {
        ...original.userAction,
        sig: 'different_signature_representation',
      },
    };

    expect(federatedRelationshipTieBreaker(remalleated)).toBe(
      federatedRelationshipTieBreaker(original),
    );
  });

  it('keeps source, actor DID, relationship kind, and target as independent keys', async () => {
    const materialize = vi.fn();
    const base = likeState({ state: true, nonce: 'base_identity_nonce_01' });
    const otherSource = likeState({
      state: true,
      nonce: 'other_source_nonce_001',
      sourceDomain: 'other.social',
    });
    const otherActor = likeState({
      state: true,
      nonce: 'other_actor_nonce_0001',
      did: 'did:key:zBobSigningKey',
    });
    const otherTarget = likeState({
      state: true,
      nonce: 'other_target_nonce_001',
      target: 'swarm:local.social:660e8400-e29b-41d4-a716-446655440000',
    });
    const repost: FederatedRelationshipStateInput = {
      ...base,
      relationshipKind: 'repost',
      userAction: signedAction({
        action: 'repost',
        nonce: 'other_kind_nonce_00001',
      }),
    };

    for (const input of [base, otherSource, otherActor, otherTarget, repost]) {
      await expect(apply(input, materialize)).resolves.toMatchObject({ applied: true });
    }

    expect(materialize).toHaveBeenCalledTimes(5);
    expect(await client.get(
      'SELECT COUNT(*) AS count FROM swarm_relationship_states',
    )).toEqual({ count: 5 });
  });

  it('rolls back both the ordering claim and materialized mutation on failure', async () => {
    const input = likeState({ state: true, nonce: 'rollback_action_nonce_01' });

    await expect(database.transaction(async (tx) => (
      applyOrderedFederatedRelationshipState(tx, input, async (state) => {
        await tx.run(sql`
          INSERT INTO relationship_effects (id, state)
          VALUES ('effect-1', ${state})
        `);
        throw new Error('materialization failed');
      })
    ))).rejects.toThrow('materialization failed');

    expect(await client.get(
      'SELECT COUNT(*) AS count FROM swarm_relationship_states',
    )).toEqual({ count: 0 });
    expect(await client.get(
      'SELECT COUNT(*) AS count FROM relationship_effects',
    )).toEqual({ count: 0 });

    const retry = await database.transaction(async (tx) => (
      applyOrderedFederatedRelationshipState(tx, input, async (state) => {
        await tx.run(sql`
          INSERT INTO relationship_effects (id, state)
          VALUES ('effect-1', ${state})
        `);
      })
    ));

    expect(retry).toMatchObject({ applied: true });
    expect(await client.get(
      'SELECT state FROM relationship_effects WHERE id = ?',
      'effect-1',
    )).toEqual({ state: 1 });
  });

  it('rejects a transition whose requested state contradicts the signed verb', async () => {
    const materialize = vi.fn();
    const contradictory = likeState({
      state: true,
      nonce: 'contradictory_nonce_001',
    });
    contradictory.state = false;

    await expect(apply(contradictory, materialize)).rejects.toThrow(
      'Signed like action cannot set like state',
    );
    expect(materialize).not.toHaveBeenCalled();
    expect(await client.get(
      'SELECT COUNT(*) AS count FROM swarm_relationship_states',
    )).toEqual({ count: 0 });
  });
});
