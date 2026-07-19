import type { LocalCollectionPost } from '@/lib/collections/data';
import { parseLinkPreviewMediaJson } from '@/lib/media/linkPreview';
import { isTrustedFederationMediaUrl } from '@/lib/utils/federation';

export function mapCollectionPostForSwarm(
  post: LocalCollectionPost,
  nodeDomain: string,
  nodeIsNsfw: boolean,
): Record<string, unknown> {
  const mapEmbedded = (embedded: LocalCollectionPost['repostOf']) => embedded ? {
    id: embedded.id,
    originalPostId: embedded.id,
    content: embedded.content,
    createdAt: embedded.createdAt.toISOString(),
    isNsfw: embedded.isNsfw,
    nodeIsNsfw,
    likesCount: embedded.likesCount,
    repostsCount: embedded.repostsCount,
    repliesCount: embedded.repliesCount,
    nodeDomain,
    author: {
      handle: embedded.author.handle,
      displayName: embedded.author.displayName || embedded.author.handle,
      avatarUrl: embedded.author.avatarUrl || undefined,
      isNsfw: embedded.author.isNsfw,
      nodeIsNsfw,
      nodeDomain,
    },
    media: embedded.media.filter((item) => isTrustedFederationMediaUrl(item.url)).map((item) => ({
      url: item.url,
      mimeType: item.mimeType || undefined,
      altText: item.altText || undefined,
    })),
  } : undefined;

  return {
    id: post.id,
    originalPostId: post.id,
    content: post.content,
    createdAt: post.createdAt.toISOString(),
    isNsfw: post.isNsfw,
    nodeIsNsfw,
    likesCount: post.likesCount,
    repostsCount: post.repostsCount,
    repliesCount: post.repliesCount,
    nodeDomain,
    author: {
      handle: post.author.handle,
      displayName: post.author.displayName || post.author.handle,
      avatarUrl: post.author.avatarUrl || undefined,
      isNsfw: post.author.isNsfw,
      nodeIsNsfw,
      nodeDomain,
    },
    media: post.media.filter((item) => isTrustedFederationMediaUrl(item.url)).map((item) => ({
      url: item.url,
      mimeType: item.mimeType || undefined,
      altText: item.altText || undefined,
    })),
    linkPreviewUrl: post.linkPreviewUrl || undefined,
    linkPreviewTitle: post.linkPreviewTitle || undefined,
    linkPreviewDescription: post.linkPreviewDescription || undefined,
    linkPreviewImage: post.linkPreviewImage && isTrustedFederationMediaUrl(post.linkPreviewImage)
      ? post.linkPreviewImage
      : undefined,
    linkPreviewType: post.linkPreviewType === 'card'
      || post.linkPreviewType === 'image'
      || post.linkPreviewType === 'gallery'
      || post.linkPreviewType === 'video'
      ? post.linkPreviewType
      : undefined,
    linkPreviewVideoUrl: post.linkPreviewVideoUrl && isTrustedFederationMediaUrl(post.linkPreviewVideoUrl)
      ? post.linkPreviewVideoUrl
      : undefined,
    linkPreviewMedia: parseLinkPreviewMediaJson(post.linkPreviewMediaJson)?.filter((item) => (
      isTrustedFederationMediaUrl(item.url)
    )),
    repostOfId: post.repostOfId || undefined,
    repostOf: mapEmbedded(post.repostOf),
  };
}
