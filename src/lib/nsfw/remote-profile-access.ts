import { getSession } from '@/lib/auth';
import { requireLocalNodeNsfwClassification } from '@/lib/node/local-node';
import { canAccessSensitiveRemoteProfile } from './feed-access';

export const SENSITIVE_REMOTE_PROFILE_MESSAGE =
    'Sign in and enable NSFW viewing to access profiles and posts from adult-only nodes.';

export const SENSITIVE_PROFILE_MESSAGE =
    'This profile and its posts are hidden by your sensitive-content settings.';

export interface CurrentViewerSensitiveProfileAccess {
    allowed: boolean;
    profileRequiresNsfw: boolean;
    nodeIsNsfw: boolean;
}

export async function getCurrentViewerSensitiveProfileAccess({
    accountIsNsfw,
    nodeIsNsfw,
    isRemote = false,
}: {
    accountIsNsfw?: boolean;
    nodeIsNsfw?: boolean;
    isRemote?: boolean;
}): Promise<CurrentViewerSensitiveProfileAccess> {
    try {
        const [session, localNodeIsNsfw] = await Promise.all([
            getSession(),
            requireLocalNodeNsfwClassification(),
        ]);
        const remoteClassificationUnknown = isRemote && (
            typeof accountIsNsfw !== 'boolean'
            || typeof nodeIsNsfw !== 'boolean'
        );
        const effectiveNodeIsNsfw = isRemote
            ? nodeIsNsfw === true
            : nodeIsNsfw ?? localNodeIsNsfw;
        const profileRequiresNsfw = remoteClassificationUnknown
            || accountIsNsfw === true
            || effectiveNodeIsNsfw;

        return {
            allowed: canAccessSensitiveRemoteProfile({
                profileRequiresNsfw,
                viewer: session?.user ?? null,
                localNodeIsNsfw,
            }),
            profileRequiresNsfw,
            nodeIsNsfw: effectiveNodeIsNsfw,
        };
    } catch (error) {
        console.error('Sensitive profile access lookup failed:', error);
        return {
            allowed: false,
            profileRequiresNsfw: true,
            nodeIsNsfw: nodeIsNsfw ?? true,
        };
    }
}

export async function canCurrentViewerAccessSensitiveRemoteProfile(
    classification: {
        accountIsNsfw?: boolean;
        nodeIsNsfw?: boolean;
    },
): Promise<boolean> {
    const access = await getCurrentViewerSensitiveProfileAccess({
        ...classification,
        isRemote: true,
    });
    return access.allowed;
}
