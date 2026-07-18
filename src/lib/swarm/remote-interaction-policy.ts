import { db } from '@/db';
import { normalizeNodeDomain } from './node-domain';

export interface VerifiedRemoteActorIdentity {
  did: string;
  handle: string;
  domain: string;
}

export type RemoteInteractionPolicyDatabase = Pick<typeof db, 'query'>;

interface CachedActorRow {
  id: string;
  handle: string;
}

function cachedRemoteActorId(row: CachedActorRow | null | undefined): string | null {
  return row && (row.handle.includes('@') || row.id.startsWith('swarm:'))
    ? row.id
    : null;
}

/**
 * Return true when an otherwise verified remote interaction should be treated
 * as a successful no-op under the local recipient's moderation policy.
 *
 * This helper is deliberately read-only. Call it before identity pinning,
 * replay claims, notifications, counters, or relationship writes.
 */
export async function shouldSuppressRemoteInteraction(
  recipientUserId: string,
  actor: VerifiedRemoteActorIdentity,
  database: RemoteInteractionPolicyDatabase = db,
): Promise<boolean> {
  const actorDomain = normalizeNodeDomain(actor.domain);
  const actorHandle = actor.handle.trim().replace(/^@/, '').toLowerCase();
  const fullActorHandle = `${actorHandle}@${actorDomain}`;

  const nodeMute = await database.query.mutedNodes.findFirst({
    where: { AND: [{ userId: recipientUserId }, { nodeDomain: actorDomain }] },
    columns: { id: true },
  });
  if (nodeMute) return true;

  // Query both immutable identity and current address. Legacy directory hints
  // can leave one stale row behind, and moderation on either representation
  // must continue to win without first mutating identity state.
  const [actorByDid, actorByHandle] = await Promise.all([
    database.query.users.findFirst({
      where: { did: actor.did },
      columns: { id: true, handle: true },
    }),
    database.query.users.findFirst({
      where: { handle: fullActorHandle },
      columns: { id: true, handle: true },
    }),
  ]);
  const cachedActorIds = [...new Set([
    cachedRemoteActorId(actorByDid),
    cachedRemoteActorId(actorByHandle),
  ].filter((id): id is string => Boolean(id)))];
  if (cachedActorIds.length === 0) return false;

  const actorIdCondition = cachedActorIds.length === 1
    ? cachedActorIds[0]
    : { in: cachedActorIds };
  const [block, mute] = await Promise.all([
    database.query.blocks.findFirst({
      where: {
        OR: [
          {
            AND: [
              { userId: recipientUserId },
              { blockedUserId: actorIdCondition },
            ],
          },
          {
            AND: [
              { userId: actorIdCondition },
              { blockedUserId: recipientUserId },
            ],
          },
        ],
      },
      columns: { id: true },
    }),
    database.query.mutes.findFirst({
      where: {
        AND: [
          { userId: recipientUserId },
          { mutedUserId: actorIdCondition },
        ],
      },
      columns: { id: true },
    }),
  ]);

  return Boolean(block || mute);
}
