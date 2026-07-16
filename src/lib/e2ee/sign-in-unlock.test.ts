import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  fetchE2EEVaultStatus,
  provisionE2EEAccount,
  rewrapE2EEAccount,
  unlockE2EEAccount,
  restoreE2EEKeyMaterial,
} = vi.hoisted(() => ({
  fetchE2EEVaultStatus: vi.fn(),
  provisionE2EEAccount: vi.fn(),
  rewrapE2EEAccount: vi.fn(),
  unlockE2EEAccount: vi.fn(),
  restoreE2EEKeyMaterial: vi.fn(),
}));

vi.mock('./client', () => ({
  fetchE2EEVaultStatus,
  provisionE2EEAccount,
  rewrapE2EEAccount,
  unlockE2EEAccount,
}));
vi.mock('./local-key-store', () => ({ restoreE2EEKeyMaterial }));

import { unlockE2EEFromSignIn } from './sign-in-unlock';

const input = {
  did: 'did:synapsis:alice',
  handle: 'alice',
  password: 'account-password',
};
const configured = {
  ownerDid: input.did,
  configured: true as const,
  keyId: 'k1_current-key-material',
  keyVersion: 2,
  publicKey: 'public-key',
  salt: 'salt',
  kdfAlgorithm: 'argon2id13' as const,
  kdfOpsLimit: 2,
  kdfMemLimit: 64 * 1024 * 1024,
  recoveryMethod: 'password' as const,
  failedAttempts: 0,
  attemptsRemaining: 10,
  lockedUntil: null,
};

describe('encrypted messages after sign-in', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    restoreE2EEKeyMaterial.mockResolvedValue(null);
  });

  it('uses the sign-in password to unlock an existing vault before navigation', async () => {
    fetchE2EEVaultStatus.mockResolvedValue(configured);
    await unlockE2EEFromSignIn(input);
    expect(unlockE2EEAccount).toHaveBeenCalledWith(input.did, input.password, configured);
  });

  it('sets up encrypted messages from the sign-in password when needed', async () => {
    fetchE2EEVaultStatus.mockResolvedValue({ ownerDid: input.did, configured: false });
    await unlockE2EEFromSignIn(input);
    expect(provisionE2EEAccount).toHaveBeenCalledWith({
      did: input.did,
      handle: input.handle,
      password: input.password,
      currentPassword: input.password,
    });
  });

  it('does not hide automatic setup failures from the sign-in flow', async () => {
    const setupError = new Error('Encrypted messages were not set up');
    fetchE2EEVaultStatus.mockResolvedValue({ ownerDid: input.did, configured: false });
    provisionE2EEAccount.mockRejectedValue(setupError);

    await expect(unlockE2EEFromSignIn(input)).rejects.toBe(setupError);
  });

  it('does no recovery work when the current password vault is already remembered', async () => {
    fetchE2EEVaultStatus.mockResolvedValue(configured);
    restoreE2EEKeyMaterial.mockResolvedValue({
      keyId: configured.keyId,
      publicKey: configured.publicKey,
      privateKey: 'private-key',
    });
    await unlockE2EEFromSignIn(input);
    expect(unlockE2EEAccount).not.toHaveBeenCalled();
    expect(rewrapE2EEAccount).not.toHaveBeenCalled();
  });

  it('removes a legacy PIN automatically when its key is remembered', async () => {
    const legacy = { ...configured, recoveryMethod: 'legacy_pin' as const };
    const material = {
      keyId: configured.keyId,
      publicKey: configured.publicKey,
      privateKey: 'private-key',
    };
    fetchE2EEVaultStatus.mockResolvedValue(legacy);
    restoreE2EEKeyMaterial.mockResolvedValue(material);
    await unlockE2EEFromSignIn(input);
    expect(rewrapE2EEAccount).toHaveBeenCalledWith({
      did: input.did,
      handle: input.handle,
      material,
      keyVersion: legacy.keyVersion,
      password: input.password,
      currentPassword: input.password,
    });
  });

  it('does not destroy a legacy vault when its old PIN is still required', async () => {
    fetchE2EEVaultStatus.mockResolvedValue({ ...configured, recoveryMethod: 'legacy_pin' });
    await unlockE2EEFromSignIn(input);
    expect(unlockE2EEAccount).not.toHaveBeenCalled();
    expect(provisionE2EEAccount).not.toHaveBeenCalled();
  });
});
