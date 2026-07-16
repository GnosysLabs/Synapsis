'use client';

import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { useUserIdentity } from '@/lib/hooks/useUserIdentity';
import { unlockE2EEFromSignIn } from '@/lib/e2ee/sign-in-unlock';

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
    login: (user?: User) => Promise<void>;
    logout: (userId?: string) => Promise<void>;
    switchAccount: (userId: string) => Promise<void>;
    refreshAuth: () => Promise<void>;
    updateUserProfile: (updates: Partial<User>) => void;
    lockIdentity: () => Promise<void>;  // New: manual lock
    signUserAction: (action: string, data: any) => Promise<any>;
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
        setLoading(true);
        try {
            const res = await fetch('/api/auth/me', { cache: 'no-store' });
            const data = await res.json();
            await applyAuthState({
                user: res.ok ? data.user ?? null : null,
                accounts: res.ok ? data.accounts ?? [] : [],
            });
        } catch {
            await applyAuthState({ user: null, accounts: [] });
        } finally {
            setLoading(false);
        }
    }, [applyAuthState]);

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
            try {
                // Consume the credential while sign-in already has it. Only
                // the encrypted chat key is persisted; the password is not.
                await unlockE2EEFromSignIn({
                    did: targetUser.did,
                    handle: targetUser.handle,
                    password,
                });
            } catch (error) {
                // Authentication succeeded independently. Leave Chat's
                // recovery screen available if its vault is damaged or stale.
                console.warn('[Auth] Could not prepare encrypted messages after sign-in:', error);
            }
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
     * Manually set the user state (called after successful login)
     */
    const login = useCallback(async (_userData?: User) => {
        await refreshAuth();
    }, [refreshAuth]);

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
            setShowUnlockPrompt(false);
            await refreshAuth();
        } catch (error) {
            console.error('[Auth] Logout failed:', error);
            throw error;
        }
    }, [refreshAuth]);

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

            await refreshAuth();
        } catch (error) {
            console.error('[Auth] Switch account failed:', error);
            throw error;
        } finally {
            setLoading(false);
        }
    }, [refreshAuth]);

    const updateUserProfile = useCallback((updates: Partial<User>) => {
        setUser(current => current ? { ...current, ...updates } : current);
        setAccounts(current => current.map(account => account.id === updates.id ? { ...account, ...updates } : account));
    }, []);

    // Load auth state on mount
    useEffect(() => {
        refreshAuth();
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
