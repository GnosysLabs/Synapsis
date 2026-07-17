import { getSession } from '@/lib/auth';
import { isLocalNodeNsfw } from '@/lib/node/local-node';
import { canAccessSensitiveRemoteProfile } from './feed-access';

export const SENSITIVE_REMOTE_PROFILE_MESSAGE =
    'Sign in and enable NSFW viewing to access profiles and posts from adult-only nodes.';

export async function canCurrentViewerAccessSensitiveRemoteProfile(
    profileRequiresNsfw: boolean,
): Promise<boolean> {
    if (!profileRequiresNsfw) return true;

    try {
        const [session, localNodeIsNsfw] = await Promise.all([
            getSession(),
            isLocalNodeNsfw(),
        ]);

        return canAccessSensitiveRemoteProfile({
            profileRequiresNsfw,
            viewer: session?.user ?? null,
            localNodeIsNsfw,
        });
    } catch (error) {
        console.error('Remote sensitive profile access lookup failed:', error);
        return false;
    }
}
