'use client';

import {
  fetchE2EEVaultStatus,
  provisionE2EEAccount,
  rewrapE2EEAccount,
  unlockE2EEAccount,
} from './client';
import { restoreE2EEKeyMaterial } from './local-key-store';

export async function unlockE2EEFromSignIn(input: {
  did: string;
  handle: string;
  password: string;
}): Promise<void> {
  const status = await fetchE2EEVaultStatus(input.did);
  if (!status.configured) {
    await provisionE2EEAccount({
      did: input.did,
      handle: input.handle,
      password: input.password,
      currentPassword: input.password,
      ...(status.previousKey ? { replacesKeyId: status.previousKey.keyId } : {}),
    });
    return;
  }

  const local = await restoreE2EEKeyMaterial(input.did);
  const hasCurrentLocalKey = local?.keyId === status.keyId
    && local.publicKey === status.publicKey;
  if (hasCurrentLocalKey) {
    if (status.recoveryMethod === 'legacy_pin') {
      await rewrapE2EEAccount({
        did: input.did,
        handle: input.handle,
        material: local,
        keyVersion: status.keyVersion,
        password: input.password,
        currentPassword: input.password,
      });
    }
    return;
  }

  // A legacy vault without a remembered local key still needs the old PIN
  // once so its existing history is not silently discarded.
  if (status.recoveryMethod === 'legacy_pin') return;
  await unlockE2EEAccount(input.did, input.password, status);
}
