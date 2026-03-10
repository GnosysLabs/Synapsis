export interface User {
    id: string;
    handle: string;
    displayName: string;
    avatarUrl?: string | null;
    bio?: string | null;
    headerUrl?: string | null;
    followersCount?: number;
    followingCount?: number;
    postsCount?: number;
    website?: string | null;
    createdAt?: string;
    movedTo?: string | null;
    isRemote?: boolean;
    profileUrl?: string | null;
    isBot?: boolean;
    isSwarm?: boolean; // Whether this user is from a Synapsis swarm node
    nodeDomain?: string | null; // Domain of the node this user is from (for swarm users)
    did?: string;
    canReceiveDms?: boolean;
    dmPrivacy?: 'everyone' | 'following' | 'none';
    botOwner?: {
        id: string;
        handle: string;
        displayName?: string | null;
        avatarUrl?: string | null;
    } | null;
}

export interface MediaItem {
    id: string;
    url: string;
    altText?: string | null;
    mimeType?: string | null;
}

export interface Attachment {
    id: string;
    url: string;
    altText?: string | null;
}

export interface LinkPreviewMediaItem {
    url: string;
    width?: number | null;
    height?: number | null;
    mimeType?: string | null;
}

export interface Post {
    id: string;
    content: string;
    createdAt: string;
    likesCount: number;
    repostsCount: number;
    repliesCount: number;
    author: User;
    media?: MediaItem[];
    linkPreviewUrl?: string | null;
    linkPreviewTitle?: string | null;
    linkPreviewDescription?: string | null;
    linkPreviewImage?: string | null;
    linkPreviewType?: 'card' | 'image' | 'gallery' | 'video' | null;
    linkPreviewVideoUrl?: string | null;
    linkPreviewMedia?: LinkPreviewMediaItem[] | null;
    replyTo?: Post | null;
    replyToId?: string | null;
    repostOf?: Post | null;
    repostOfId?: string | null;
    // Swarm reply info (when replying to a post on another node)
    swarmReplyToId?: string | null;
    swarmReplyToContent?: string | null;
    swarmReplyToAuthor?: {
        handle: string;
        displayName?: string | null;
        avatarUrl?: string | null;
        nodeDomain?: string | null;
    } | null;
    isLiked?: boolean;
    isReposted?: boolean;
    bot?: {
        id: string;
        name: string;
        handle: string;
        ownerId: string;
    } | null;
    nodeDomain?: string | null; // Domain of the node this post came from (for swarm posts)
    isSwarm?: boolean; // Whether this is a swarm post from another node
    originalPostId?: string; // Original post ID on the source node (for swarm posts)
}
