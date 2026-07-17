'use client';

import { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import { useUserIdentity } from '@/lib/hooks/useUserIdentity';
import { unlockE2EEFromSignIn } from '@/lib/e2ee/sign-in-unlock';

const AUTH_SYNC_CHANNEL = 'synapsis-auth-state';
const AUTH_SYNC_STORAGE_KEY = 'synapsis:auth-state-changed';

export interface User {
    id: string;
    handle: string;
    displayName: string;
    email?: string;
    avatarUrl?: string | null;
    did?: string;
    publicKey?: string;
    privateKeyEncrypted?: string;
    isNsfw?: boolean;
    nsfwEnabled?: boolean;
    ageVerifiedAt?: string | null;
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
    unlockIdentity: (password: string, explicitUser?: User) => Promise<void>;
    login: (user: User, password: string) => Promise<void>;
    logout: (userId?: string) => Promise<void>;
    switchAccount: (userId: string) => Promise<void>;
    refreshAuth: () => Promise<void>;
    updateUserProfile: (updates: Partial<User>) => void;
    lockIdentity: () => Promise<void>;  // New: manual lock
    signUserAction: (action: string, data: unknown) => Promise<unknown>;
    requiresUnlock: boolean;  // True if user has encrypted key but not unlocked
    showUnlockPrompt: boolean;
    setShowUnlockPrompt: (show: boolean) => void;
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
    unlockIdentity: async () => { },
    login: async () => { },
    logout: async () => { },
    switchAccount: async () => { },
    refreshAuth: async () => { },
    updateUserProfile: () => { },
    lockIdentity: async () => { },
    signUserAction: async () => Promise.reject('Not initialized'),
    requiresUnlock: false,
    showUnlockPrompt: false,
    setShowUnlockPrompt: () => { },
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
    const [user, setUser] = useState<User | null>(null);
    const [accounts, setAccounts] = useState<AuthAccount[]>([]);
    const [isAdmin, setIsAdmin] = useState(false);
    const [loading, setLoading] = useState(true);
    const [showUnlockPrompt, setShowUnlockPrompt] = useState(false);
    const authGenerationRef = useRef(0);

    // Integrate useUserIdentity hook with persistence
    const {
        identity,
        isUnlocked,
        isRestoring,
        initializeIdentity,
        unlockIdentity: unlockIdentityHook,
        lockIdentity: lockIdentityHook,
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
        const nextAccounts = data.accounts ?? [];
        setAccounts(nextAccounts);
        setUser(data.user);

        if (data.user?.did && data.user?.publicKey) {
            await initializeIdentity({
                did: data.user.did,
                handle: data.user.handle,
                publicKey: data.user.publicKey,
                privateKeyEncrypted: data.user.privateKeyEncrypted,
            });
            await checkAdmin();
        } else {
            await clearIdentity();
            setIsAdmin(false);
        }
    }, [checkAdmin, clearIdentity, initializeIdentity]);

    const refreshAuth = useCallback(async () => {
        const generation = ++authGenerationRef.current;
        setLoading(true);
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
            if (generation === authGenerationRef.current) setLoading(false);
        }
    }, [applyAuthState]);

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

        setShowUnlockPrompt(false); // Close prompt on success
    }, [user, unlockIdentityHook]);

    /**
     * Manually lock the identity (user wants to secure their session)
     */
    const lockIdentity = useCallback(async () => {
        await lockIdentityHook();
    }, [lockIdentityHook]);

    /**
     * Complete a password sign-in as one ordered operation. Applying the
     * returned user directly invalidates any older /auth/me request, then the
     * same ephemeral credential unlocks identity and encrypted messages before
     * the login screen is allowed to navigate away.
     */
    const login = useCallback(async (userData: User, password: string) => {
        const generation = ++authGenerationRef.current;
        setLoading(true);
        // The server session has already changed by the time login is called.
        // Invalidate every other tab before identity/E2EE initialization can wait
        // or fail so stale authorized content is removed immediately.
        broadcastAuthChange();
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
        } finally {
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
            setShowUnlockPrompt(false);
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
        window.addEventListener('focus', refreshFromAnotherContext);

        return () => {
            channel?.removeEventListener('message', refreshFromAnotherContext);
            channel?.close();
            window.removeEventListener('storage', onStorage);
            window.removeEventListener('focus', refreshFromAnotherContext);
        };
    }, [refreshAuth]);

    // Determine if unlock is required (has encrypted key but not unlocked)
    const requiresUnlock = !!user?.privateKeyEncrypted && !isUnlocked && !isRestoring;
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
            unlockIdentity,
            login,
            logout,
            switchAccount,
            refreshAuth,
            updateUserProfile,
            lockIdentity,
            signUserAction,
            requiresUnlock,
            showUnlockPrompt,
            setShowUnlockPrompt,
        }}>
            {children}
        </AuthContext.Provider>
    );
}

export const useAuth = () => useContext(AuthContext);
