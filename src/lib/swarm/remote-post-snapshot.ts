import { serializeLinkPreviewMedia } from '@/lib/media/linkPreview';
import { normalizeNodeDomain } from './node-domain';
import { parseRemotePostDetailResponse } from './remote-post-payload';
import { signedFederationRead } from './signed-read';

export async function fetchRemotePostSnapshot(domain: string, originalPostId: string) {
  try {
    const normalizedDomain = normalizeNodeDomain(domain);
    const protocol = normalizedDomain.includes('localhost') ? 'http' : 'https';
    const response = await signedFederationRead(
      `${protocol}://${normalizedDomain}/api/swarm/posts/${originalPostId}`,
      {
        headers: { Accept: 'application/json' },
        timeoutMs: 5_000,
        maxResponseBytes: 1024 * 1024,
      },
    );

    if (response.status < 200 || response.status >= 300) return null;
    const { post } = parseRemotePostDetailResponse(
      response.json(),
      normalizedDomain,
      originalPostId,
    );

    return {
      authorHandle: post.author.handle,
      authorDisplayName: post.author.displayName || post.author.handle,
      authorAvatarUrl: post.author.avatarUrl || null,
      content: post.content,
      postCreatedAt: new Date(post.createdAt),
      likesCount: post.likesCount ?? 0,
      repostsCount: post.repostsCount ?? 0,
      repliesCount: post.repliesCount ?? 0,
      linkPreviewUrl: post.linkPreviewUrl || null,
      linkPreviewTitle: post.linkPreviewTitle || null,
      linkPreviewDescription: post.linkPreviewDescription || null,
      linkPreviewImage: post.linkPreviewImage || null,
      linkPreviewType: post.linkPreviewType || null,
      linkPreviewVideoUrl: post.linkPreviewVideoUrl || null,
      linkPreviewMediaJson: serializeLinkPreviewMedia(post.linkPreviewMedia),
      mediaJson: post.media?.length ? JSON.stringify(post.media) : null,
    };
  } catch {
    return null;
  }
}
