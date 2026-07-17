export interface SensitiveContentViewer {
    nsfwEnabled?: boolean;
    ageVerifiedAt?: string | Date | null;
}

export interface PostSensitivityInput {
    postIsNsfw?: boolean;
    authorIsNsfw?: boolean;
    nodeIsNsfw?: boolean;
    isRemote: boolean;
}

export interface UserSensitivityInput {
    accountIsNsfw?: boolean;
    nodeIsNsfw?: boolean;
    isRemote: boolean;
}

/**
 * User fields that are safe to include in a public profile or post-author DTO.
 *
 * Database user records also contain authentication material, private signing
 * keys, storage credentials, moderation notes, and viewer-only preferences.
 * Keep this as an explicit allowlist so adding a database column can never
 * silently make that column public through a joined post relation.
 */
const PUBLIC_USER_SUMMARY_KEYS = [
    'id',
    'did',
    'handle',
    'displayName',
    'bio',
    'avatarUrl',
    'headerUrl',
    'publicKey',
    'followersCount',
    'followingCount',
    'postsCount',
    'website',
    'createdAt',
    'movedTo',
    'isNsfw',
    'nodeIsNsfw',
    'isRemote',
    'isSwarm',
    'nodeDomain',
    'profileUrl',
    'canReceiveDms',
    'dmPrivacy',
    'nsfwRestricted',
    'sensitiveRestricted',
] as const;

export type PublicUserSummary = Partial<Record<
    (typeof PUBLIC_USER_SUMMARY_KEYS)[number],
    unknown
>>;

const PUBLIC_POST_SUMMARY_KEYS = [
    'id',
    'content',
    'createdAt',
    'updatedAt',
    'publishedAt',
    'likesCount',
    'repostsCount',
    'repliesCount',
    'likeCount',
    'repostCount',
    'replyCount',
    'isNsfw',
    'nodeIsNsfw',
    'sensitiveContentRestricted',
    'swarmReplySensitiveRestricted',
    'replyToId',
    'repostOfId',
    'swarmReplyToId',
    'swarmReplyToContent',
    'apId',
    'apUrl',
    'linkPreviewUrl',
    'linkPreviewTitle',
    'linkPreviewDescription',
    'linkPreviewImage',
    'linkPreviewType',
    'linkPreviewVideoUrl',
    'linkPreviewMediaJson',
    'isLiked',
    'isReposted',
    'nodeDomain',
    'isSwarm',
    'isRemote',
    'originalPostId',
    'repostedByCount',
    'feedActivityAt',
    'isReply',
] as const;

const PUBLIC_MEDIA_KEYS = [
    'id',
    'url',
    'altText',
    'mimeType',
    'width',
    'height',
] as const;

type PublicPostSummary = Partial<Record<
    (typeof PUBLIC_POST_SUMMARY_KEYS)[number],
    unknown
>>;

function pickPublicFields<const Keys extends readonly string[]>(
    value: Record<string, unknown>,
    keys: Keys,
): Partial<Record<Keys[number], unknown>> {
    const output: Record<string, unknown> = {};
    for (const key of keys) {
        if (Object.prototype.hasOwnProperty.call(value, key)) output[key] = value[key];
    }
    return output as Partial<Record<Keys[number], unknown>>;
}

export function serializePublicPostSummary(
    post: Record<string, unknown>,
): PublicPostSummary {
    return pickPublicFields(post, PUBLIC_POST_SUMMARY_KEYS);
}

function serializePublicMedia(value: unknown): Array<Record<string, unknown>> | null | undefined {
    if (value === null) return null;
    if (!Array.isArray(value)) return undefined;
    return value
        .filter((item): item is Record<string, unknown> => (
            Boolean(item) && typeof item === 'object' && !Array.isArray(item)
        ))
        .map((item) => pickPublicFields(item, PUBLIC_MEDIA_KEYS));
}

export function serializePublicUserSummary(
    user: Record<string, unknown>,
): PublicUserSummary {
    const summary: PublicUserSummary = {};

    for (const key of PUBLIC_USER_SUMMARY_KEYS) {
        if (Object.prototype.hasOwnProperty.call(user, key)) {
            summary[key] = user[key];
        }
    }

    return summary;
}

export function isUserSensitive({
    accountIsNsfw,
    nodeIsNsfw,
    isRemote,
}: UserSensitivityInput): boolean {
    if (accountIsNsfw === true || nodeIsNsfw === true) return true;
    return isRemote && (
        typeof accountIsNsfw !== 'boolean'
        || typeof nodeIsNsfw !== 'boolean'
    );
}

export function redactSensitiveUserSummary<
    T extends {
        isNsfw?: boolean;
        nodeIsNsfw?: boolean;
        isRemote?: boolean;
        avatarUrl?: string | null;
        headerUrl?: string | null;
        bio?: string | null;
        website?: string | null;
    },
>(user: T, canViewSensitive: boolean): T & { sensitiveRestricted?: boolean } {
    const restricted = !canViewSensitive && isUserSensitive({
        accountIsNsfw: user.isNsfw,
        nodeIsNsfw: user.nodeIsNsfw,
        isRemote: user.isRemote === true,
    });

    if (!restricted) return user;

    return {
        ...user,
        avatarUrl: null,
        headerUrl: null,
        bio: null,
        website: null,
        sensitiveRestricted: true,
    };
}

type SerializablePost = Record<string, unknown> & {
    author?: Record<string, unknown> | null;
    repostOf?: SerializablePost | null;
    replyTo?: SerializablePost | null;
    repostedBy?: Array<Record<string, unknown>>;
    swarmReplyToAuthor?: Record<string, unknown> | string | null;
};

function parseLegacyUserSummary(
    value: Record<string, unknown> | string | null | undefined,
): Record<string, unknown> | null {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    if (typeof value !== 'string') return null;

    try {
        const parsed: unknown = JSON.parse(value);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : null;
    } catch {
        return null;
    }
}

export function redactSensitivePostForViewer<T extends SerializablePost>(
    post: T,
    {
        canViewSensitive,
        localNodeDomain,
        localNodeIsNsfw,
        revealSensitiveRoot = false,
    }: {
        canViewSensitive: boolean;
        localNodeDomain: string;
        localNodeIsNsfw: boolean;
        /** Reveal only this record; nested posts remain governed by the global preference. */
        revealSensitiveRoot?: boolean;
    },
): T {
    const author = post.author || null;
    const authorHandle = typeof author?.handle === 'string' ? author.handle : '';
    const nodeDomain = typeof post.nodeDomain === 'string' ? post.nodeDomain : null;
    const isRemote = post.isSwarm === true
        || post.isRemote === true
        || author?.isRemote === true
        || (author?.nodeId !== null && author?.nodeId !== undefined)
        || authorHandle.includes('@')
        || Boolean(nodeDomain && nodeDomain !== localNodeDomain);
    const nodeIsNsfw = typeof post.nodeIsNsfw === 'boolean'
        ? post.nodeIsNsfw
        : typeof author?.nodeIsNsfw === 'boolean'
            ? author.nodeIsNsfw
            : isRemote ? undefined : localNodeIsNsfw;
    const sensitive = isPostSensitive({
        postIsNsfw: typeof post.isNsfw === 'boolean' ? post.isNsfw : undefined,
        authorIsNsfw: typeof author?.isNsfw === 'boolean' ? author.isNsfw : undefined,
        nodeIsNsfw,
        isRemote,
    });
    const safeAuthor = author
        ? serializePublicUserSummary(redactSensitiveUserSummary({
            ...author,
            isRemote,
            nodeIsNsfw,
        }, canViewSensitive))
        : author;
    const hasLegacySwarmParent = post.swarmReplyToId !== null
        && post.swarmReplyToId !== undefined
        || post.swarmReplyToContent !== null
        && post.swarmReplyToContent !== undefined
        || post.swarmReplyToAuthor !== null
        && post.swarmReplyToAuthor !== undefined;
    const legacySwarmReplyToContent = typeof post.swarmReplyToContent === 'string'
        ? post.swarmReplyToContent
        : null;
    const legacySwarmReplyToAuthor = parseLegacyUserSummary(post.swarmReplyToAuthor);
    const safeSwarmReplyToAuthor = legacySwarmReplyToAuthor
        ? serializePublicUserSummary(redactSensitiveUserSummary({
            ...legacySwarmReplyToAuthor,
            isRemote: true,
        }, canViewSensitive))
        : null;
    const base = {
        ...serializePublicPostSummary(post),
        author: safeAuthor,
        media: serializePublicMedia(post.media),
        linkPreviewMedia: serializePublicMedia(post.linkPreviewMedia),
        repostOf: post.repostOf
            ? redactSensitivePostForViewer(post.repostOf, {
                canViewSensitive,
                localNodeDomain,
                localNodeIsNsfw,
            })
            : post.repostOf,
        replyTo: post.replyTo
            ? redactSensitivePostForViewer(post.replyTo, {
                canViewSensitive,
                localNodeDomain,
                localNodeIsNsfw,
            })
            : post.replyTo,
        // Legacy reply snapshots have no persisted sensitivity classifiers.
        // Treat them as unknown remote content until the viewer opts in.
        swarmReplyToContent: !canViewSensitive && hasLegacySwarmParent
            ? null
            : legacySwarmReplyToContent,
        swarmReplyToAuthor: safeSwarmReplyToAuthor,
        ...(!canViewSensitive && hasLegacySwarmParent
            ? { swarmReplySensitiveRestricted: true }
            : {}),
        repostedBy: post.repostedBy?.map((reposter) => {
            const reposterDomain = typeof reposter.nodeDomain === 'string'
                ? reposter.nodeDomain
                : null;
            const reposterHandle = typeof reposter.handle === 'string' ? reposter.handle : '';
            return serializePublicUserSummary(redactSensitiveUserSummary({
                ...reposter,
                isRemote: reposter.isRemote === true
                    || reposterHandle.includes('@')
                    || Boolean(reposterDomain && reposterDomain !== localNodeDomain),
            }, canViewSensitive));
        }),
    } as unknown as T;

    if (canViewSensitive || revealSensitiveRoot || !sensitive) return base;

    return {
        ...base,
        content: '',
        media: [],
        linkPreviewUrl: null,
        linkPreviewTitle: null,
        linkPreviewDescription: null,
        linkPreviewImage: null,
        linkPreviewType: null,
        linkPreviewVideoUrl: null,
        linkPreviewMedia: null,
        linkPreviewMediaJson: null,
        swarmReplyToContent: null,
        sensitiveContentRestricted: true,
    } as T;
}

export function isPostSensitive({
    postIsNsfw,
    authorIsNsfw,
    nodeIsNsfw,
    isRemote,
}: PostSensitivityInput): boolean {
    if (postIsNsfw === true || authorIsNsfw === true || nodeIsNsfw === true) {
        return true;
    }

    // Old or incomplete federation payloads must never make remote media look
    // safe. A remote post is considered sensitive until all three classifiers
    // are explicitly supplied by the origin node.
    return isRemote && (
        typeof postIsNsfw !== 'boolean'
        || typeof authorIsNsfw !== 'boolean'
        || typeof nodeIsNsfw !== 'boolean'
    );
}

export function shouldHideSensitivePost({
    sensitivity,
    viewer,
    localNodeIsNsfw,
}: {
    sensitivity: PostSensitivityInput;
    viewer: SensitiveContentViewer | null;
    localNodeIsNsfw: boolean;
}): boolean {
    if (!isPostSensitive(sensitivity)) return false;
    if (!viewer) return true;

    if (!viewer.ageVerifiedAt) return true;
    // Age-verified adult-node members do not need a second, hidden preference.
    // General-purpose nodes still require the explicit viewing toggle.
    return !localNodeIsNsfw && viewer.nsfwEnabled !== true;
}

export function isRemoteAvatarSensitivityUnknown({
    seed,
    nodeDomain,
    localNodeDomain,
    isNsfw,
    nodeIsNsfw,
}: {
    seed: string;
    nodeDomain?: string | null;
    localNodeDomain?: string | null;
    isNsfw?: boolean;
    nodeIsNsfw?: boolean;
}): boolean {
    const normalizedLocalDomain = localNodeDomain?.trim().replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
    const explicitDomain = nodeDomain?.trim().replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
    const cleanSeed = seed.trim().replace(/^@/, '');
    const separator = cleanSeed.lastIndexOf('@');
    const handleDomain = separator > 0 ? cleanSeed.slice(separator + 1).toLowerCase() : null;
    const candidateDomains = [explicitDomain, handleDomain].filter(
        (domain): domain is string => Boolean(domain),
    );
    const isRemote = candidateDomains.some((domain) => domain !== normalizedLocalDomain);

    return isRemote && (
        typeof isNsfw !== 'boolean'
        || typeof nodeIsNsfw !== 'boolean'
    );
}
