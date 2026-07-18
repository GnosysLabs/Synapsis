import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const routes = [
  { name: 'like', kind: 'like', state: true, target: 'data.postId' },
  { name: 'unlike', kind: 'like', state: false, target: 'data.postId' },
  { name: 'follow', kind: 'follow', state: true, target: 'targetUser.id' },
  { name: 'unfollow', kind: 'follow', state: false, target: 'targetUser.id' },
  { name: 'repost', kind: 'repost', state: true, target: 'data.postId' },
  { name: 'unrepost', kind: 'repost', state: false, target: 'data.postId' },
] as const;

describe('inbound relationship ordering wiring', () => {
  it.each(routes)(
    'orders $name state after durable replay claiming and before mutation',
    ({ name, kind, state, target }) => {
      const source = readFileSync(resolve(
        'src/app/api/swarm/interactions',
        name,
        'route.ts',
      ), 'utf8');
      const replayClaim = source.indexOf('const [claim] = await tx.insert(swarmInboundActions)');
      const orderingCall = source.indexOf(
        'const ordered = await applyOrderedFederatedRelationshipState(tx, {',
      );
      const orderingCallback = source.indexOf('}, async () => {', orderingCall);
      const orderingConfig = source.slice(orderingCall, orderingCallback);

      expect(replayClaim).toBeGreaterThan(-1);
      expect(orderingCall).toBeGreaterThan(replayClaim);
      expect(orderingCallback).toBeGreaterThan(orderingCall);
      expect(orderingConfig).toContain(`relationshipKind: '${kind}'`);
      expect(orderingConfig).toContain(`target: ${target}`);
      expect(orderingConfig).toContain(`state: ${state}`);
      expect(orderingConfig).toContain('userAction: verified.userAction');
      expect(source).toContain(
        "return ordered.reason === 'duplicate' ? 'replay' as const : 'stale' as const;",
      );
    },
  );
});
