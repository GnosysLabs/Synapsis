'use client';

import { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import { useUserIdentity } from '@/lib/hooks/useUserIdentity';
import { unlockE2EEFromSignIn } from '@/lib/e2ee/sign-in-unlock';
import { parseAccountAddress } from '@/lib/identity/account-address';
import type { StuffboxBadge } from '@/lib/types';

const AUTH_SYNC_CHANNEL = 'synapsis-auth-state';
const AUTH_SYNC_STORAGE_KEY = 'synapsis:auth-state-changed';

export interface User {
    id: string;
    handle: string;
    username?: string;
    homeDomain?: string;
    isLocalAccount?: boolean;
    displayName: string;
    email?: string;
    avatarUrl?: string | null;
    bio?: string | null;
    headerUrl?: string | null;
    website?: string | null;
    profileVersion?: number | null;
    did?: string;
    publicKey?: string;
    privateKeyEncrypted?: string;
    isNsfw?: boolean;
    nsfwEnabled?: boolean;
    ageVerifiedAt?: string | null;
    stuffboxBadge?: StuffboxBadge | null;
    movedFrom?: string | null;
    sourceCleanupConfirmed?: boolean;
}

export interface AuthAccount extends User {
    isActive: boolean;
}

interface AuthContextType {
    user: User | null;
    accounts: AuthAccount[];
    activeAccountId: string | null;
    isAdmin: boolean;
    loading: boolean;
    isIdentityUnlocked: boolean;
    isRestoring: boolean;  // True while checking persistence
    did: string | null;
    handle: string | null;
    checkAdmin: () => Promise<void>;
    login: (user: User, password: string) => Promise<void>;
    logout: (userId?: string) => Promise<void>;
    switchAccount: (userId: string) => Promise<void>;
    refreshAuth: () => Promise<void>;
    updateUserProfile: (updates: Partial<User>) => void;
    signUserAction: (action: string, data: unknown) => Promise<unknown>;
}

const AuthContext = createContext<AuthContextType>({
    user: null,
    accounts: [],
    activeAccountId: null,
    isAdmin: false,
    loading: true,
    isIdentityUnlocked: false,
    isRestoring: false,
    did: null,
    handle: null,
    checkAdmin: async () => { },
    login: async () => { },
    logout: async () => { },
    switchAccount: async () => { },
    refreshAuth: async () => { },
    updateUserProfile: () => { },
    signUserAction: async () => Promise.reject('Not initialized'),
});

function canonicalAuthUser<T extends User>(user: T): T {
    const address = parseAccountAddress(user.handle);
    if (!address) {
        throw new Error('Authentication response contained a non-canonical account address');
    }
    return {
        ...user,
        handle: address.canonical,
        username: address.username,
        homeDomain: address.homeDomain,
    };
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
    const [user, setUser] = useState<User | null>(null);
    const [accounts, setAccounts] = useState<AuthAccount[]>([]);
    const [isAdmin, setIsAdmin] = useState(false);
    const [loading, setLoading] = useState(true);
    const authGenerationRef = useRef(0);
    const signInInProgressRef = useRef(false);
    const initialAuthResolvedRef = useRef(false);

    // Integrate useUserIdentity hook with persistence
    const {
        identity,
        isUnlocked,
        isRestoring,
        initializeIdentity,
        unlockIdentity: unlockIdentityHook,
        clearIdentity,
        signUserAction,
    } = useUserIdentity();

    const checkAdmin = useCallback(async () => {
        try {
            const res = await fetch('/api/admin/me');
            const data = await res.json();
            setIsAdmin(!!data.isAdmin);
        } catch {
            setIsAdmin(false);
        }
    }, []);

    const applyAuthState = useCallback(async (data: { user: User | null; accounts?: AuthAccount[] | null }) => {
        const nextUser = data.user ? canonicalAuthUser(data.user) : null;
        const nextAccounts = (data.accounts ?? []).map((account) => canonicalAuthUser(account));
        setAccounts(nextAccounts);
        setUser(nextUser);

        if (nextUser?.did && nextUser?.publicKey) {
            await initializeIdentity({
                did: nextUser.did,
                handle: nextUser.handle,
                publicKey: nextUser.publicKey,
                privateKeyEncrypted: nextUser.privateKeyEncrypted,
            });
            await checkAdmin();
        } else {
            await clearIdentity();
            setIsAdmin(false);
        }
    }, [checkAdmin, clearIdentity, initializeIdentity]);

    const refreshAuth = useCallback(async () => {
        // A focus/storage event must not invalidate the ordered sign-in
        // operation while it is initializing the account and E2EE identity.
        if (signInInProgressRef.current) return;
        const generation = ++authGenerationRef.current;
        const blocksAppBootstrap = !initialAuthResolvedRef.current;
        if (blocksAppBootstrap) setLoading(true);
        try {
            const res = await fetch('/api/auth/me', { cache: 'no-store' });
            const data = await res.json();
            if (generation !== authGenerationRef.current) return;
            await applyAuthState({
                user: res.ok ? data.user ?? null : null,
                accounts: res.ok ? data.accounts ?? [] : [],
            });
        } catch {
            if (generation !== authGenerationRef.current) return;
            await applyAuthState({ user: null, accounts: [] });
        } finally {
            if (generation === authGenerationRef.current) {
                initialAuthResolvedRef.current = true;
                if (blocksAppBootstrap) setLoading(false);
            }
        }
    }, [applyAuthState]);

    const refreshStuffboxBadge = useCallback(async () => {
        if (signInInProgressRef.current || !user) return;
        const generation = authGenerationRef.current;
        try {
            const res = await fetch('/api/auth/me', { cache: 'no-store' });
            if (!res.ok || generation !== authGenerationRef.current) return;
            const data = await res.json() as {
                user?: User | null;
                accounts?: AuthAccount[];
            };
            if (!data.user || data.user.id !== user.id) return;
            const refreshedUser = data.user;
            setUser(current => current?.id === refreshedUser.id
                ? { ...current, stuffboxBadge: refreshedUser.stuffboxBadge ?? null }
                : current);
            const badgeByAccount = new Map(
                (data.accounts ?? []).map(account => [account.id, account.stuffboxBadge ?? null]),
            );
            setAccounts(current => current.map(account => badgeByAccount.has(account.id)
                ? { ...account, stuffboxBadge: badgeByAccount.get(account.id) }
                : account));
        } catch {
            // Keep the last verified badge during a transient refresh failure.
        }
    }, [user]);

    const broadcastAuthChange = useCallback(() => {
        if (typeof window === 'undefined') return;
        const marker = `${Date.now()}:${Math.random().toString(36).slice(2)}`;
        if (typeof BroadcastChannel !== 'undefined') {
            const channel = new BroadcastChannel(AUTH_SYNC_CHANNEL);
            channel.postMessage(marker);
            channel.close();
            return;
        }
        try {
            window.localStorage.setItem(AUTH_SYNC_STORAGE_KEY, marker);
        } catch {
            // Focus refresh below remains the fallback when storage is unavailable.
        }
    }, []);

    /**
     * Unlock the user's identity with their password
     * Persists the key for auto-unlock on refresh
     */
    const unlockIdentity = useCallback(async (password: string, explicitUser?: User) => {
        const targetUser = explicitUser || user;

        if (!targetUser?.privateKeyEncrypted) {
            throw new Error('No encrypted private key available');
        }

        await unlockIdentityHook(
            targetUser.privateKeyEncrypted,
            password,
            targetUser.did,
            targetUser.handle,
            targetUser.publicKey
        );

        if (targetUser.did && targetUser.handle) {
            // Consume the credential while the user has already supplied it.
            // Only encrypted key material is persisted; the password is not.
            await unlockE2EEFromSignIn({
                did: targetUser.did,
                handle: targetUser.handle,
                password,
            });
        }

    }, [user, unlockIdentityHook]);

    /**
     * Complete a password sign-in as one ordered operation. Applying the
     * returned user directly invalidates any older /auth/me request, then the
     * same ephemeral credential unlocks identity and encrypted messages before
     * the login screen is allowed to navigate away.
     */
    const login = useCallback(async (userData: User, password: string) => {
        signInInProgressRef.current = true;
        const generation = ++authGenerationRef.current;
        setLoading(true);
        try {
            await applyAuthState({
                user: userData,
                accounts: [{ ...userData, isActive: true }],
            });
            if (generation !== authGenerationRef.current) {
                throw new Error('Active account changed while signing in');
            }
            await unlockIdentity(password, userData);
            if (generation !== authGenerationRef.current) {
                throw new Error('Active account changed while signing in');
            }
            // Notify other tabs only after this tab has completed the ordered
            // sign-in. Broadcasting earlier lets their refreshes race setup.
            broadcastAuthChange();
        } finally {
            signInInProgressRef.current = false;
            if (generation === authGenerationRef.current) setLoading(false);
        }
    }, [applyAuthState, broadcastAuthChange, unlockIdentity]);

    /**
     * Logout the user and clear their identity
     */
    const logout = useCallback(async (userId?: string) => {
        try {
            await fetch('/api/auth/logout', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(userId ? { userId } : {}),
            });
            broadcastAuthChange();
            await refreshAuth();
        } catch (error) {
            console.error('[Auth] Logout failed:', error);
            throw error;
        }
    }, [broadcastAuthChange, refreshAuth]);

    const switchAccount = useCallback(async (userId: string) => {
        try {
            setLoading(true);
            const res = await fetch('/api/auth/switch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId }),
            });

            const data = await res.json();
            if (!res.ok) {
                throw new Error(data.error || 'Failed to switch account');
            }

            broadcastAuthChange();
            await refreshAuth();
        } catch (error) {
            console.error('[Auth] Switch account failed:', error);
            throw error;
        } finally {
            setLoading(false);
        }
    }, [broadcastAuthChange, refreshAuth]);

    const updateUserProfile = useCallback((updates: Partial<User>) => {
        setUser(current => current ? { ...current, ...updates } : current);
        setAccounts(current => current.map(account => (
            account.id === (updates.id ?? user?.id)
                ? { ...account, ...updates }
                : account
        )));
        broadcastAuthChange();
    }, [broadcastAuthChange, user?.id]);

    // Load auth state on mount
    useEffect(() => {
        refreshAuth();
    }, [refreshAuth]);

    useEffect(() => {
        const refreshFromAnotherContext = () => {
            void refreshAuth();
        };
        const channel = typeof BroadcastChannel !== 'undefined'
            ? new BroadcastChannel(AUTH_SYNC_CHANNEL)
            : null;
        channel?.addEventListener('message', refreshFromAnotherContext);
        const onStorage = (event: StorageEvent) => {
            if (event.key === AUTH_SYNC_STORAGE_KEY) refreshFromAnotherContext();
        };
        window.addEventListener('storage', onStorage);

        return () => {
            channel?.removeEventListener('message', refreshFromAnotherContext);
            channel?.close();
            window.removeEventListener('storage', onStorage);
        };
    }, [refreshAuth]);

    useEffect(() => {
        const refreshWhenActive = () => {
            if (document.visibilityState === 'visible') void refreshStuffboxBadge();
        };
        window.addEventListener('focus', refreshWhenActive);
        document.addEventListener('visibilitychange', refreshWhenActive);
        return () => {
            window.removeEventListener('focus', refreshWhenActive);
            document.removeEventListener('visibilitychange', refreshWhenActive);
        };
    }, [refreshStuffboxBadge]);

    const activeAccountId = user?.id ?? null;

    return (
        <AuthContext.Provider value={{
            user,
            accounts,
            activeAccountId,
            isAdmin,
            loading,
            isIdentityUnlocked: isUnlocked,
            isRestoring,
            did: identity?.did || null,
            handle: identity?.handle || null,
            checkAdmin,
            login,
            logout,
            switchAccount,
            refreshAuth,
            updateUserProfile,
            signUserAction,
        }}>
            {children}
        </AuthContext.Provider>
    );
}

export const useAuth = () => useContext(AuthContext);
