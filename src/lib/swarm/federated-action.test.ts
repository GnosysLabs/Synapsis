import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  verifyActionSignature: vi.fn(),
  signingPublicKeyFromDid: vi.fn(),
  isRateLimited: vi.fn(),
  verifySwarmRequest: vi.fn(),
  consumeFederationNodeActionQuota: vi.fn(),
}));

vi.mock('@/lib/auth/verify-signature', () => ({
  verifyActionSignature: mocks.verifyActionSignature,
}));

vi.mock('@/lib/crypto/did-key', () => ({
  signingPublicKeyFromDid: mocks.signingPublicKeyFromDid,
}));

vi.mock('@/lib/rate-limit', () => ({
  isRateLimited: mocks.isRateLimited,
}));

vi.mock('./signature', () => ({
  verifySwarmRequest: mocks.verifySwarmRequest,
}));

vi.mock('./action-quota', () => ({
  DEFAULT_FEDERATED_NODE_ACTIONS_PER_WINDOW: 600,
  consumeFederationNodeActionQuota: mocks.consumeFederationNodeActionQuota,
}));

import {
  FEDERATED_ACTION_MAX_AGE_MS,
  FEDERATED_ACTION_PROTOCOL,
  verifyFederatedUserAction,
  type FederatedUserAction,
  type FederationActionContext,
} from './federated-action';

const NOW = 1_750_000_000_000;
const SOURCE_DOMAIN = 'remote.social';
const DESTINATION_DOMAIN = 'local.social';
const ACTION_PATH = '/api/swarm/interactions/like';
const POST_ID = 'swarm:local.social:550e8400-e29b-41d4-a716-446655440000';

function userAction(
  overrides: Partial<FederatedUserAction> = {},
): FederatedUserAction {
  return {
    action: 'like',
    data: { postId: POST_ID },
    did: 'did:key:zAliceSigningKey',
    handle: 'Alice',
    ts: NOW,
    nonce: 'nonce_value_123',
    sig: 'signature_value_123',
    ...overrides,
  };
}

function federationContext(
  overrides: Partial<FederationActionContext> = {},
): FederationActionContext {
  return {
    protocol: FEDERATED_ACTION_PROTOCOL,
    sourceDomain: SOURCE_DOMAIN,
    destinationDomain: DESTINATION_DOMAIN,
    method: 'POST',
    path: ACTION_PATH,
    issuedAt: NOW,
    expiresAt: NOW + 60_000,
    ...overrides,
  };
}

function payload(
  contextOverrides: Partial<FederationActionContext> = {},
  actionOverrides: Partial<FederatedUserAction> = {},
) {
  return {
    federation: federationContext(contextOverrides),
    userAction: userAction(actionOverrides),
    postId: '550e8400-e29b-41d4-a716-446655440000',
  };
}

type VerificationInput = Parameters<typeof verifyFederatedUserAction>[0];

function verificationInput(
  requestPayload = payload(),
  overrides: Partial<VerificationInput> = {},
): VerificationInput {
  return {
    payload: requestPayload,
    nodeSignature: 'node_signature_123',
    sourceDomain: SOURCE_DOMAIN,
    expectedMethod: 'POST',
    expectedPath: ACTION_PATH,
    expectedAction: 'like',
    actorHandle: '@ALICE',
    replayBinding: { postId: POST_ID },
    now: NOW,
    ...overrides,
  };
}

describe('federated user action verification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('NEXT_PUBLIC_NODE_DOMAIN', DESTINATION_DOMAIN);
    mocks.verifySwarmRequest.mockResolvedValue(true);
    mocks.signingPublicKeyFromDid.mockReturnValue('DID-DERIVED USER PUBLIC KEY');
    mocks.verifyActionSignature.mockResolvedValue(true);
    mocks.isRateLimited.mockReturnValue(false);
    mocks.consumeFederationNodeActionQuota.mockResolvedValue({
      allowed: true,
      count: 1,
      remaining: 599,
      resetAt: NOW + 60_000,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('rejects an envelope addressed to another destination before node verification', async () => {
    const result = await verifyFederatedUserAction(verificationInput(payload({
      destinationDomain: 'other.social',
    })));

    expect(result).toEqual({
      ok: false,
      status: 403,
      error: 'Federation destination mismatch',
    });
    expect(mocks.verifySwarmRequest).not.toHaveBeenCalled();
  });

  it('rejects an envelope signed for another path before node verification', async () => {
    const result = await verifyFederatedUserAction(verificationInput(payload({
      path: '/api/swarm/interactions/repost',
    })));

    expect(result).toEqual({
      ok: false,
      status: 403,
      error: 'Federation route mismatch',
    });
    expect(mocks.verifySwarmRequest).not.toHaveBeenCalled();
  });

  it('rejects an envelope signed for another method before node verification', async () => {
    const result = await verifyFederatedUserAction(verificationInput(payload({
      method: 'DELETE',
    })));

    expect(result).toEqual({
      ok: false,
      status: 403,
      error: 'Federation route mismatch',
    });
    expect(mocks.verifySwarmRequest).not.toHaveBeenCalled();
  });

  it('rejects node-envelope tampering even when the altered context remains otherwise valid', async () => {
    const signedPayload = payload();
    const tamperedPayload = structuredClone(signedPayload);
    tamperedPayload.federation.expiresAt += 1;
    mocks.verifySwarmRequest.mockImplementation(async (candidate: unknown) => (
      JSON.stringify(candidate) === JSON.stringify(signedPayload)
    ));

    const result = await verifyFederatedUserAction(verificationInput(tamperedPayload));

    expect(result).toEqual({
      ok: false,
      status: 403,
      error: 'Invalid node signature',
    });
    expect(mocks.verifySwarmRequest).toHaveBeenCalledWith(
      tamperedPayload,
      'node_signature_123',
      SOURCE_DOMAIN,
    );
    expect(mocks.consumeFederationNodeActionQuota).not.toHaveBeenCalled();
    expect(mocks.signingPublicKeyFromDid).not.toHaveBeenCalled();
  });

  it('enforces the durable node quota after node verification and before user proof acceptance', async () => {
    mocks.consumeFederationNodeActionQuota.mockResolvedValue({
      allowed: false,
      count: 600,
      remaining: 0,
      resetAt: NOW + 60_000,
    });

    const result = await verifyFederatedUserAction(verificationInput());

    expect(result).toEqual({
      ok: false,
      status: 429,
      error: 'Federation node is sending actions too quickly',
    });
    expect(mocks.verifySwarmRequest).toHaveBeenCalledOnce();
    expect(mocks.consumeFederationNodeActionQuota).toHaveBeenCalledWith({
      sourceDomain: SOURCE_DOMAIN,
      limit: 600,
      now: NOW,
    });
    expect(mocks.signingPublicKeyFromDid).not.toHaveBeenCalled();
    expect(mocks.verifyActionSignature).not.toHaveBeenCalled();
  });

  it('rejects a user DID that cannot supply its own signing key', async () => {
    mocks.signingPublicKeyFromDid.mockReturnValue(null);

    const result = await verifyFederatedUserAction(verificationInput(payload({}, {
      did: 'did:web:remote.social:users:alice',
    })));

    expect(result).toEqual({
      ok: false,
      status: 403,
      error: 'Federated actions require a self-certifying user DID',
    });
    expect(mocks.verifyActionSignature).not.toHaveBeenCalled();
  });

  it('rejects a signature that does not match the key derived from the claimed DID', async () => {
    mocks.verifyActionSignature.mockResolvedValue(false);
    const requestPayload = payload({}, { sig: 'signature_from_another_key' });

    const result = await verifyFederatedUserAction(verificationInput(requestPayload));

    expect(result).toEqual({
      ok: false,
      status: 403,
      error: 'Invalid user signature',
    });
    expect(mocks.signingPublicKeyFromDid).toHaveBeenCalledWith(
      'did:key:zAliceSigningKey',
    );
    expect(mocks.verifyActionSignature).toHaveBeenCalledWith(
      requestPayload.userAction,
      'DID-DERIVED USER PUBLIC KEY',
    );
  });

  it.each([
    {
      caseName: 'issued outside the acceptance window',
      context: {
        issuedAt: NOW - FEDERATED_ACTION_MAX_AGE_MS - 1,
        expiresAt: NOW - 1,
      },
    },
    {
      caseName: 'already expired',
      context: {
        issuedAt: NOW - 1_000,
        expiresAt: NOW - 1,
      },
    },
  ])('rejects a node envelope that is $caseName', async ({ context }) => {
    const result = await verifyFederatedUserAction(verificationInput(payload(context)));

    expect(result).toEqual({
      ok: false,
      status: 400,
      error: 'Federation envelope is stale',
    });
    expect(mocks.verifySwarmRequest).not.toHaveBeenCalled();
  });

  it('rejects a stale user action even when its node envelope is fresh', async () => {
    const result = await verifyFederatedUserAction(verificationInput(
      payload({}, { ts: NOW - 60_001 }),
      { maxUserActionAgeMs: 60_000 },
    ));

    expect(result).toEqual({
      ok: false,
      status: 400,
      error: 'Federated user action is stale',
    });
    expect(mocks.verifySwarmRequest).toHaveBeenCalledOnce();
    expect(mocks.signingPublicKeyFromDid).not.toHaveBeenCalled();
  });

  it('charges a source-node bucket before a peer can evade limits with throwaway DIDs', async () => {
    mocks.isRateLimited.mockImplementation((key: string) => (
      key.startsWith('federated-node-action:')
    ));

    await expect(verifyFederatedUserAction(verificationInput())).resolves.toMatchObject({
      ok: false,
      status: 429,
    });
    expect(mocks.isRateLimited).toHaveBeenCalledWith(
      `federated-node-action:${SOURCE_DOMAIN}`,
      600,
      60_000,
    );
  });

  it('binds replay identity to the verified route and method', async () => {
    const alternatePath = '/api/swarm/interactions/like/alternate';
    const baseInput = verificationInput();
    const sameRoute = await verifyFederatedUserAction(baseInput);
    const repeatedRoute = await verifyFederatedUserAction(baseInput);
    const otherPath = await verifyFederatedUserAction(verificationInput(
      payload({ path: alternatePath }),
      { expectedPath: alternatePath },
    ));
    const otherMethod = await verifyFederatedUserAction(verificationInput(
      payload({ method: 'DELETE' }),
      { expectedMethod: 'DELETE' },
    ));

    if (!sameRoute.ok || !repeatedRoute.ok || !otherPath.ok || !otherMethod.ok) {
      throw new Error('Expected all valid route-bound actions to verify');
    }
    expect(repeatedRoute.replayId).toBe(sameRoute.replayId);
    expect(otherPath.replayId).not.toBe(sameRoute.replayId);
    expect(otherMethod.replayId).not.toBe(sameRoute.replayId);
  });

  it('does not let signature representation change replay identity', async () => {
    const original = await verifyFederatedUserAction(verificationInput());
    const remalleated = await verifyFederatedUserAction(verificationInput(
      payload({}, { sig: 'different_signature_value_456' }),
    ));

    if (!original.ok || !remalleated.ok) {
      throw new Error('Expected both signed representations to verify');
    }
    expect(remalleated.replayId).toBe(original.replayId);
  });
});
