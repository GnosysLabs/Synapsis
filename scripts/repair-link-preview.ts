import { and, eq } from 'drizzle-orm';
import { closeDb, db, posts, users } from '../src/db';
import {
  findLinkPreviewUrlInText,
  serializeLinkPreviewMedia,
} from '../src/lib/media/linkPreview';
import { resolveLinkPreview } from '../src/lib/media/resolveLinkPreview';

const POST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function repair(postId: string): Promise<void> {
  if (!POST_ID_PATTERN.test(postId)) {
    throw new Error(`Invalid post ID: ${postId}`);
  }

  const [post] = await db.select({
    id: posts.id,
    content: posts.content,
    linkPreviewUrl: posts.linkPreviewUrl,
  })
    .from(posts)
    .innerJoin(users, eq(users.id, posts.userId))
    .where(and(eq(posts.id, postId), eq(users.isLocalAccount, true)))
    .limit(1);

  if (!post) throw new Error(`Local post not found: ${postId}`);
  if (post.linkPreviewUrl) {
    console.log(`${postId}: preview already present`);
    return;
  }

  const url = findLinkPreviewUrlInText(post.content);
  if (!url) throw new Error(`${postId}: post content does not contain a previewable URL`);

  const preview = await resolveLinkPreview(url);
  await db.update(posts).set({
    linkPreviewUrl: preview.url,
    linkPreviewTitle: preview.title,
    linkPreviewDescription: preview.description,
    linkPreviewImage: preview.image,
    linkPreviewType: preview.type,
    linkPreviewVideoUrl: preview.videoUrl,
    linkPreviewMediaJson: serializeLinkPreviewMedia(preview.media),
    updatedAt: new Date(),
  }).where(eq(posts.id, postId));

  console.log(`${postId}: repaired ${preview.title || preview.url}`);
}

async function main(): Promise<void> {
  const postIds = process.argv.slice(2);
  if (postIds.length === 0) {
    throw new Error('Provide at least one local post ID to repair');
  }
  for (const postId of postIds) await repair(postId);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
