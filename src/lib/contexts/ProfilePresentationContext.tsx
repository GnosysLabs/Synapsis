'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useAuth } from '@/lib/contexts/AuthContext';
import { resolveAccountAddress } from '@/lib/identity/account-address';
import type { ProfilePresentation } from '@/lib/profile/stored-presentation';

type PresentationInput = Partial<Omit<ProfilePresentation, 'handle' | 'nodeDomain'>> & {
  handle?: string;
  nodeDomain?: string | null;
};

interface ProfilePresentationContextValue {
  ensurePresentation: (handle: string, nodeDomain?: string | null) => void;
  getPresentation: (handle: string, nodeDomain?: string | null) => ProfilePresentation | null | undefined;
  publishVerifiedPresentation: (presentation: PresentationInput) => void;
  invalidatePresentation: (handle: string, nodeDomain?: string | null) => void;
}

const ProfilePresentationContext = createContext<ProfilePresentationContextValue | null>(null);

function normalizePresentation(value: PresentationInput): ProfilePresentation | null {
  if (value.profilePresentationVerified !== true || !value.handle) return null;
  const address = resolveAccountAddress(value.handle, value.nodeDomain);
  if (!address) return null;
  return {
    handle: address.canonical,
    displayName: typeof value.displayName === 'string' && value.displayName.trim()
      ? value.displayName.trim()
      : address.username,
    avatarUrl: typeof value.avatarUrl === 'string' && value.avatarUrl.trim()
      ? value.avatarUrl.trim()
      : null,
    did: typeof value.did === 'string' && value.did ? value.did : null,
    nodeDomain: address.homeDomain,
    isNsfw: typeof value.isNsfw === 'boolean' ? value.isNsfw : undefined,
    nodeIsNsfw: typeof value.nodeIsNsfw === 'boolean' ? value.nodeIsNsfw : undefined,
    stuffboxBadge: value.stuffboxBadge ?? null,
    profilePresentationVerified: true,
    profileVersion: typeof value.profileVersion === 'number' ? value.profileVersion : null,
    ...(value.sensitiveRestricted ? { sensitiveRestricted: true } : {}),
  };
}

export function ProfilePresentationProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  // undefined means not looked up yet; null means the lookup found no verified
  // overlay. Neither state is a verified claim that the account has no avatar.
  const entriesRef = useRef(new Map<string, ProfilePresentation | null>());
  const queuedRef = useRef(new Set<string>());
  const inFlightRef = useRef(new Set<string>());
  const flushTimerRef = useRef<number | null>(null);
  const flushRef = useRef<() => void>(() => undefined);
  const [revision, setRevision] = useState(0);

  const publishVerifiedPresentation = useCallback((input: PresentationInput) => {
    const presentation = normalizePresentation(input);
    if (!presentation) return;
    const current = entriesRef.current.get(presentation.handle);
    const currentVersion = current?.profileVersion ?? -1;
    const incomingVersion = presentation.profileVersion ?? -1;
    if (current && currentVersion > incomingVersion) return;
    entriesRef.current.set(presentation.handle, presentation);
    setRevision((value) => value + 1);
  }, []);

  const flush = useCallback(async () => {
    const handles = [...queuedRef.current].slice(0, 100);
    handles.forEach((handle) => {
      queuedRef.current.delete(handle);
      inFlightRef.current.add(handle);
    });
    if (handles.length === 0) return;
    try {
      const response = await fetch('/api/profile-presentations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ handles }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || !Array.isArray(body?.presentations)) return;

      const received = new Map<string, ProfilePresentation>();
      for (const value of body.presentations as PresentationInput[]) {
        const presentation = normalizePresentation(value);
        if (presentation) received.set(presentation.handle, presentation);
      }
      for (const handle of handles) {
        const presentation = received.get(handle) ?? null;
        const current = entriesRef.current.get(handle);
        const currentVersion = current?.profileVersion ?? -1;
        const incomingVersion = presentation?.profileVersion ?? -1;
        if (!current || incomingVersion >= currentVersion) {
          entriesRef.current.set(handle, presentation);
        }
      }
      setRevision((value) => value + 1);
    } catch (error) {
      console.warn('[ProfilePresentation] Batch lookup failed', error);
    } finally {
      handles.forEach((handle) => inFlightRef.current.delete(handle));
      if (queuedRef.current.size > 0 && flushTimerRef.current === null) {
        flushTimerRef.current = window.setTimeout(() => {
          flushTimerRef.current = null;
          flushRef.current();
        }, 0);
      }
    }
  }, []);
  flushRef.current = () => void flush();

  const ensurePresentation = useCallback((handle: string, nodeDomain?: string | null) => {
    const address = resolveAccountAddress(handle, nodeDomain);
    if (!address
      || entriesRef.current.has(address.canonical)
      || queuedRef.current.has(address.canonical)
      || inFlightRef.current.has(address.canonical)) return;
    queuedRef.current.add(address.canonical);
    if (flushTimerRef.current === null) {
      flushTimerRef.current = window.setTimeout(() => {
        flushTimerRef.current = null;
        flushRef.current();
      }, 0);
    }
  }, []);

  const getPresentation = useCallback((handle: string, nodeDomain?: string | null) => {
    const address = resolveAccountAddress(handle, nodeDomain);
    return address ? entriesRef.current.get(address.canonical) : undefined;
  }, []);

  const invalidatePresentation = useCallback((handle: string, nodeDomain?: string | null) => {
    const address = resolveAccountAddress(handle, nodeDomain);
    if (!address) return;
    entriesRef.current.delete(address.canonical);
    ensurePresentation(address.canonical);
    setRevision((value) => value + 1);
  }, [ensurePresentation]);

  useEffect(() => {
    if (!user) return;
    publishVerifiedPresentation({
      handle: user.handle,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      did: user.did,
      nodeDomain: user.homeDomain,
      isNsfw: user.isNsfw,
      stuffboxBadge: user.stuffboxBadge,
      profilePresentationVerified: true,
      profileVersion: user.profileVersion ?? null,
    });
  }, [publishVerifiedPresentation, user]);

  useEffect(() => () => {
    if (flushTimerRef.current !== null) window.clearTimeout(flushTimerRef.current);
  }, []);

  const value: ProfilePresentationContextValue = {
    ensurePresentation,
    getPresentation,
    publishVerifiedPresentation,
    invalidatePresentation,
  };
  // The registry is ref-backed. Reading revision here documents that its state
  // update intentionally republishes the provider value to every avatar.
  void revision;

  return (
    <ProfilePresentationContext.Provider value={value}>
      {children}
    </ProfilePresentationContext.Provider>
  );
}

export function useProfilePresentationRegistry(): ProfilePresentationContextValue {
  const value = useContext(ProfilePresentationContext);
  if (!value) throw new Error('ProfilePresentationProvider is missing');
  return value;
}

export function useProfilePresentation(handle: string, nodeDomain?: string | null) {
  const registry = useProfilePresentationRegistry();
  const address = resolveAccountAddress(handle, nodeDomain);
  const canonical = address?.canonical;
  useEffect(() => {
    if (canonical) registry.ensurePresentation(canonical);
  }, [canonical, registry]);
  return canonical ? registry.getPresentation(canonical) : undefined;
}
