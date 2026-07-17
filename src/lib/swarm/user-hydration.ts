import { fetchSwarmUserProfile } from './interactions';

export interface HydratedUser {
    id: string; // The ID used in the list (usually handle or handle@domain)
    handle: string;
    displayName: string | null;
    avatarUrl?: string | null;
    bio?: string | null;
    isRemote: boolean;
    nodeDomain?: string; // For remote users
    isNsfw?: boolean;
    nodeIsNsfw?: boolean;
}

/**
 * Hydrates a list of users with fresh profile data from Swarm nodes.
 * Used for followers/following lists to ensure remote users have up-to-date info.
 * 
 * @param users List of partial user objects
 * @returns List of users with potentially updated profile data
 */
export async function hydrateSwarmUsers(
    users: {
        id: string;
        handle: string;
        displayName?: string | null;
        avatarUrl?: string | null;
        bio?: string | null;
        isRemote: boolean;
        isNsfw?: boolean;
        nodeIsNsfw?: boolean;
    }[]
): Promise<HydratedUser[]> {
    const needsHydration = users.filter(u => u.isRemote);

    if (needsHydration.length === 0) {
        return users.map(u => ({
            ...u,
            displayName: u.displayName || u.handle.split('@')[0],
        }));
    }

    // Group by domain to potentially batch (though fetchSwarmUserProfile is individual for now)
    // We'll just run them concurrently with a limit

    const hydratedMap = new Map<string, Partial<HydratedUser>>();

    // Create a promise for each remote user
    const promises = needsHydration.map(async (user) => {
        try {
            // Parse handle and domain
            // Handle format for remote users in lists is usually "user@domain.com"
            const parts = user.handle.split('@');
            if (parts.length !== 2) return; // Should be user@domain

            const handle = parts[0];
            const domain = parts[1];

            // Fetch profile
            // We set a small timeout in fetchSwarmUserProfile (10s), but we might want shorter for lists?
            // standard fetchSwarmUserProfile uses 10s. Let's stick with that for now or rely on the fact 
            // api routes have their own timeouts.
            const response = await fetchSwarmUserProfile(handle, domain, 0); // 0 limit as we only want profile

            if (response && response.profile) {
                hydratedMap.set(user.id, {
                    displayName: response.profile.displayName,
                    avatarUrl: response.profile.avatarUrl,
                    bio: response.profile.bio,
                    nodeDomain: response.nodeDomain,
                    isNsfw: response.profile.isNsfw,
                    nodeIsNsfw: response.profile.nodeIsNsfw,
                });
            }
        } catch (e) {
            // Just ignore failures and keep original data
            console.warn(`Failed to hydrate user ${user.handle}:`, e);
        }
    });

    // Run all (or batch if list is huge, but pagination limits to 20-50 usually)
    await Promise.allSettled(promises);

    // Merge results
    return users.map(user => {
        const freshdiv = hydratedMap.get(user.id);
        if (freshdiv) {
            return {
                ...user,
                ...freshdiv,
                // Ensure display name fallback
                displayName: freshdiv.displayName || user.displayName || user.handle.split('@')[0],
            };
        }
        return {
            ...user,
            displayName: user.displayName || user.handle.split('@')[0],
        };
    });
}
