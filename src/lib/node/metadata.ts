import type { Metadata } from 'next';

export const DEFAULT_NODE_DESCRIPTION = 'A swarm social network node.';

type NodeBranding = {
    name?: string | null;
    description?: string | null;
};

export function buildNodeLinkMetadata(
    node?: NodeBranding | null,
    fallbackName = 'Synapsis',
    fallbackDescription = DEFAULT_NODE_DESCRIPTION
): Pick<Metadata, 'title' | 'description' | 'openGraph' | 'twitter'> {
    const title = node?.name?.trim() || fallbackName;
    const description = node?.description?.trim() || fallbackDescription;

    return {
        title: {
            default: title,
            template: `%s | ${title}`,
        },
        description,
        openGraph: {
            type: 'website',
            siteName: title,
            title,
            description,
        },
        twitter: {
            card: 'summary',
            title,
            description,
        },
    };
}
