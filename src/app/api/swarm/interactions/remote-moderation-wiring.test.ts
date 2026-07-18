import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const routes = [
  { name: 'like', message: 'Like received' },
  { name: 'repost', message: 'Repost received' },
  { name: 'follow', message: 'Follow received' },
] as const;

describe('inbound remote moderation wiring', () => {
  it.each(routes)(
    'suppresses $name before identity or relationship writes',
    ({ name, message }) => {
      const source = readFileSync(resolve(
        'src/app/api/swarm/interactions',
        name,
        'route.ts',
      ), 'utf8');
      const policyCall = source.indexOf('if (await shouldSuppressRemoteInteraction');
      const identityWrite = source.indexOf('await pinVerifiedFederatedActorIdentity', policyCall);
      const stateWrite = source.indexOf('const outcome = await db.transaction', policyCall);
      const noOpResponse = source.indexOf(
        `return NextResponse.json({ success: true, message: '${message}' });`,
        policyCall,
      );

      expect(policyCall).toBeGreaterThan(-1);
      expect(noOpResponse).toBeGreaterThan(policyCall);
      expect(identityWrite).toBeGreaterThan(noOpResponse);
      expect(stateWrite).toBeGreaterThan(identityWrite);
    },
  );
});
