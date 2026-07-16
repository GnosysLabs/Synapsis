'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  fetchE2EEVaultStatus,
  migrateLegacyE2EEAccount,
  provisionE2EEAccount,
  unlockE2EEAccount,
  type E2EEClientError,
} from './client';
import { restoreE2EEKeyMaterial } from './local-key-store';
import type { E2EEKeyMaterial, E2EEVaultStatus } from './protocol';

type ConfiguredVaultStatus = Extract<E2EEVaultStatus, { configured: true }>;

function requireConfiguredVault(status: E2EEVaultStatus): ConfiguredVaultStatus {
  if (!status.configured) {
    throw new Error('Encrypted message vault is not configured');
  }
  return status;
}

export type E2EEIdentityState =
  | { status: 'loading' }
  | { status: 'setup_required'; previousKey?: { keyId: string; keyVersion: number } }
  | { status: 'locked'; vault: ConfiguredVaultStatus }
  | { status: 'migration_required'; material: E2EEKeyMaterial; vault: ConfiguredVaultStatus }
  | { status: 'ready'; material: E2EEKeyMaterial; vault: ConfiguredVaultStatus }
  | { status: 'error'; message: string };

const LOADING_IDENTITY_STATE: E2EEIdentityState = { status: 'loading' };

export function useE2EEIdentity(did?: string | null, handle?: string | null) {
  const [state, setState] = useState<E2EEIdentityState>(LOADING_IDENTITY_STATE);
  const [stateOwnerDid, setStateOwnerDid] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const generationRef = useRef(0);
  const channelSourceRef = useRef<string | null>(null);

  const bootstrap = useCallback(async () => {
    const generation = ++generationRef.current;
    if (!did) {
      setState(LOADING_IDENTITY_STATE);
      setStateOwnerDid(null);
      setBusy(false);
      setActionError(null);
      return;
    }
    setState(LOADING_IDENTITY_STATE);
    setStateOwnerDid(null);
    setBusy(false);
    setActionError(null);
    try {
      const vault = await fetchE2EEVaultStatus(did);
      if (generation !== generationRef.current) return;
      if (!vault.configured) {
        setStateOwnerDid(did);
        setState({ status: 'setup_required', previousKey: vault.previousKey });
        return;
      }

      const local = await restoreE2EEKeyMaterial(did);
      if (generation !== generationRef.current) return;
      if (local && local.keyId === vault.keyId && local.publicKey === vault.publicKey) {
        setStateOwnerDid(did);
        setState(vault.recoveryMethod === 'legacy_pin'
          ? { status: 'migration_required', material: local, vault }
          : { status: 'ready', material: local, vault });
        return;
      }
      setStateOwnerDid(did);
      setState({ status: 'locked', vault });
    } catch (error) {
      if (generation !== generationRef.current) return;
      setStateOwnerDid(did);
      setState({ status: 'error', message: error instanceof Error ? error.message : 'Encrypted messages could not be loaded' });
    }
  }, [did]);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    if (!did || typeof BroadcastChannel === 'undefined') return;
    channelSourceRef.current ??= crypto.randomUUID();
    const channel = new BroadcastChannel('synapsis-e2ee');
    channel.onmessage = (event) => {
      if (event.data?.did === did && event.data?.type === 'key-updated'
        && event.data?.source !== channelSourceRef.current) {
        void bootstrap();
      }
    };
    return () => channel.close();
  }, [did, bootstrap]);

  const broadcastUpdate = useCallback(() => {
    if (!did || typeof BroadcastChannel === 'undefined') return;
    const channel = new BroadcastChannel('synapsis-e2ee');
    channel.postMessage({ type: 'key-updated', did, source: channelSourceRef.current });
    channel.close();
  }, [did]);

  const setup = useCallback(async (password: string) => {
    if (!did || !handle) return;
    const generation = ++generationRef.current;
    setBusy(true);
    setActionError(null);
    try {
      const material = await provisionE2EEAccount({
        did,
        handle,
        password,
        currentPassword: password,
        ...(state.status === 'setup_required' && state.previousKey
          ? { replacesKeyId: state.previousKey.keyId }
          : {}),
      });
      const vault = requireConfiguredVault(await fetchE2EEVaultStatus(did));
      broadcastUpdate();
      if (generation !== generationRef.current) return;
      setStateOwnerDid(did);
      setState({ status: 'ready', material, vault });
    } catch (error) {
      if (generation !== generationRef.current) return;
      setActionError(error instanceof Error ? error.message : 'Encrypted messages were not set up');
      throw error;
    } finally {
      if (generation === generationRef.current) setBusy(false);
    }
  }, [did, handle, state, broadcastUpdate]);

  const unlock = useCallback(async (password: string) => {
    if (!did || state.status !== 'locked') return;
    const generation = ++generationRef.current;
    setBusy(true);
    setActionError(null);
    try {
      const material = await unlockE2EEAccount(did, password, state.vault);
      const vault = requireConfiguredVault(await fetchE2EEVaultStatus(did));
      broadcastUpdate();
      if (generation !== generationRef.current) return;
      setStateOwnerDid(did);
      setState({ status: 'ready', material, vault });
    } catch (error) {
      if (generation !== generationRef.current) return;
      const clientError = error as E2EEClientError;
      setActionError(clientError.message || 'Encrypted messages could not be unlocked');
      if (clientError.details?.lockedUntil || clientError.details?.attemptsRemaining !== undefined) {
        setState({
          status: 'locked',
          vault: {
            ...state.vault,
            lockedUntil: typeof clientError.details.lockedUntil === 'string'
              ? clientError.details.lockedUntil
              : state.vault.lockedUntil,
            attemptsRemaining: typeof clientError.details.attemptsRemaining === 'number'
              ? clientError.details.attemptsRemaining
              : state.vault.attemptsRemaining,
          },
        });
      }
      throw error;
    } finally {
      if (generation === generationRef.current) setBusy(false);
    }
  }, [did, state, broadcastUpdate]);

  const migrate = useCallback(async (password: string, legacyPin?: string) => {
    if (!did || !handle || (state.status !== 'locked' && state.status !== 'migration_required')) return;
    if (state.vault.recoveryMethod !== 'legacy_pin') return;
    const generation = ++generationRef.current;
    setBusy(true);
    setActionError(null);
    try {
      const material = await migrateLegacyE2EEAccount({
        did,
        handle,
        status: state.vault,
        password,
        legacyPin,
        ...(state.status === 'migration_required' ? { material: state.material } : {}),
      });
      const vault = requireConfiguredVault(await fetchE2EEVaultStatus(did));
      broadcastUpdate();
      if (generation !== generationRef.current) return;
      setStateOwnerDid(did);
      setState({ status: 'ready', material, vault });
    } catch (error) {
      if (generation !== generationRef.current) return;
      setActionError(error instanceof Error ? error.message : 'Encrypted message recovery could not be updated');
      throw error;
    } finally {
      if (generation === generationRef.current) setBusy(false);
    }
  }, [did, handle, state, broadcastUpdate]);

  const reset = useCallback(async (currentPassword: string) => {
    if (!did || !handle || (state.status !== 'locked' && state.status !== 'migration_required')) return;
    const generation = ++generationRef.current;
    setBusy(true);
    setActionError(null);
    try {
      const material = await provisionE2EEAccount({
        did,
        handle,
        password: currentPassword,
        replacesKeyId: state.vault.keyId,
        currentPassword,
      });
      const vault = requireConfiguredVault(await fetchE2EEVaultStatus(did));
      broadcastUpdate();
      if (generation !== generationRef.current) return;
      setStateOwnerDid(did);
      setState({ status: 'ready', material, vault });
    } catch (error) {
      if (generation !== generationRef.current) return;
      setActionError(error instanceof Error ? error.message : 'Encrypted messages were not reset');
      throw error;
    } finally {
      if (generation === generationRef.current) setBusy(false);
    }
  }, [did, handle, state, broadcastUpdate]);

  const visibleState: E2EEIdentityState = did && stateOwnerDid === did
    ? state
    : LOADING_IDENTITY_STATE;

  return { state: visibleState, busy, actionError, setup, unlock, migrate, reset, retry: bootstrap };
}
