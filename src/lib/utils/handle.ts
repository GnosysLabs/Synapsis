import { useDomain } from '@/lib/contexts/ConfigContext';
import {
    accountHomeDomain,
    accountUsername,
    canonicalAccountAddress,
    displayAccountAddress,
    isAccountOnNode,
    parseAccountAddress,
    sameAccountAddress,
} from '@/lib/identity/account-address';

// Build-time domain fallback (for SSR/non-React contexts)
export const NODE_DOMAIN = process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:43821';

export function formatFullHandle(handle: string, nodeDomain?: string | null): string {
    if (!handle) return '';
    const canonical = canonicalAccountAddress(handle, nodeDomain || NODE_DOMAIN);
    return canonical ? displayAccountAddress(canonical) : '';
}

export function getCanonicalHandle(handle: string, nodeDomain?: string | null): string | null {
    return canonicalAccountAddress(handle, nodeDomain);
}

export function getHandleUsername(handle: string): string | null {
    return accountUsername(handle);
}

export function getHandleDomain(handle: string): string | null {
    return accountHomeDomain(handle);
}

export function sameAccountHandle(left: string, right: string): boolean {
    return sameAccountAddress(left, right);
}

export function isHandleOnNode(handle: string, nodeDomain: string): boolean {
    return isAccountOnNode(handle, nodeDomain);
}

export function getProfilePath(handle: string, nodeDomain?: string | null): string {
    const canonical = canonicalAccountAddress(handle, nodeDomain);
    return canonical ? `/u/${encodeURIComponent(canonical)}` : '/u';
}

export function getPostPath(handle: string, postId: string, nodeDomain?: string | null): string {
    const profilePath = getProfilePath(handle, nodeDomain);
    return profilePath === '/u' ? `/posts/${encodeURIComponent(postId)}` : `${profilePath}/posts/${encodeURIComponent(postId)}`;
}

/**
 * React hook that formats a handle using the runtime domain config.
 * Use this in client components instead of formatFullHandle for local handles.
 * 
 * @param handle - The user handle (with or without domain)
 * @param nodeDomain - Optional domain override for swarm posts
 */
export function useFormattedHandle(handle: string, nodeDomain?: string | null): string {
    const runtimeDomain = useDomain();
    return formatFullHandle(handle, nodeDomain || runtimeDomain);
}

export { displayAccountAddress, parseAccountAddress };
