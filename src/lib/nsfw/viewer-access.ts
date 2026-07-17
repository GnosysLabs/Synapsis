import { getSession } from '@/lib/auth';
import { requireLocalNodeNsfwClassification } from '@/lib/node/local-node';
import { shouldIncludeNsfwFeed } from './feed-access';

export async function getSensitiveContentViewerAccess() {
    const [session, localNodeIsNsfw] = await Promise.all([
        getSession().catch(() => null),
        requireLocalNodeNsfwClassification(),
    ]);
    const viewer = session?.user ?? null;

    return {
        viewer,
        localNodeIsNsfw,
        canViewSensitive: shouldIncludeNsfwFeed({ viewer, localNodeIsNsfw }),
    };
}
