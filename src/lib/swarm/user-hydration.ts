import { fetchSwarmUserProfile } from './interactions';
import { mapWithConcurrency } from '@/lib/async/concurrency';
import {
    canonicalAccountHomeDomain,
    parseAccountAddress,
} from '@/lib/identity/account-address';
import { getCanonicalSwarmSeedDomain } from './node-domain';
import { isNodeBlocked } from './node-blocklist';

const MAX_REMOTE_USERS_TO_HYDRATE = 50;
const MAX_CONCURRENT_PROFILE_HYDRATIONS = 6;

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
        nodeDomain?: string;
        isNsfw?: boolean;
        nodeIsNsfw?: boolean;
    }[]
): Promise<HydratedUser[]> {
    const needsHydration = users
        .filter(u => u.isRemote)
        .slice(0, MAX_REMOTE_USERS_TO_HYDRATE);

    if (needsHydration.length === 0) {
        return users.map(u => ({
            ...u,
            displayName: u.displayName || parseAccountAddress(u.handle)?.username || u.handle,
        }));
    }

    // Group by domain to potentially batch (though fetchSwarmUserProfile is individual for now)
    // We'll just run them concurrently with a limit

    const hydratedMap = new Map<string, Partial<HydratedUser>>();
    const blockedUserIds = new Set<string>();

    await mapWithConcurrency(
        needsHydration,
        MAX_CONCURRENT_PROFILE_HYDRATIONS,
        async (user) => {
        try {
            // Parse handle and domain
            // Handle format for remote users in lists is usually "user@domain.com"
            const address = parseAccountAddress(user.handle);
            if (!address) return;
            const handle = address.username;
            const domain = getCanonicalSwarmSeedDomain(address.homeDomain);
            const assertedDomain = canonicalAccountHomeDomain(
                user.nodeDomain || address.homeDomain,
            );
            if (!domain || assertedDomain !== domain) return;

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
            } else if (await isNodeBlocked(domain)) {
                // A transient profile fetch failure may use the cached summary,
                // but an administrator block is a hard visibility boundary.
                blockedUserIds.add(user.id);
            }
        } catch (e) {
            // Just ignore failures and keep original data
            console.warn(`Failed to hydrate user ${user.handle}:`, e);
        }
        },
    );

    // Merge results
    return users.filter(user => !blockedUserIds.has(user.id)).map(user => {
        const freshdiv = hydratedMap.get(user.id);
        if (freshdiv) {
            return {
                ...user,
                ...freshdiv,
                // Ensure display name fallback
                displayName: freshdiv.displayName || user.displayName || parseAccountAddress(user.handle)?.username || user.handle,
            };
        }
        return {
            ...user,
            displayName: user.displayName || parseAccountAddress(user.handle)?.username || user.handle,
        };
    });
}
