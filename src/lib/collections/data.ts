import { db, media, posts, users } from '@/db';

const embeddedPostRelations = {
  author: true,
  media: true,
  replyTo: {
    with: {
      author: true,
      media: true,
    },
  },
} as const;

const collectionPostRelations = {
  ...embeddedPostRelations,
  repostOf: {
    with: embeddedPostRelations,
  },
} as const;

export type EmbeddedCollectionPost = typeof posts.$inferSelect & {
  author: typeof users.$inferSelect;
  media: Array<typeof media.$inferSelect>;
};

export type LocalCollectionPost = EmbeddedCollectionPost & {
  replyTo?: EmbeddedCollectionPost | null;
  repostOf?: EmbeddedCollectionPost | null;
  isLiked?: boolean;
  isReposted?: boolean;
};

function eligibleCollectionPost(
  post: Pick<typeof posts.$inferSelect, 'userId' | 'isRemoved'>,
  ownerId: string,
) {
  return post.userId === ownerId && !post.isRemoved;
}

function uniquePreviewImages(
  memberships: Array<{
    post: Pick<typeof posts.$inferSelect, 'userId' | 'isRemoved' | 'isNsfw' | 'createdAt'> & {
      media: Array<Pick<typeof media.$inferSelect, 'url'>>;
    };
  }>,
  ownerId: string,
) {
  const urls = memberships
    .filter(({ post }) => eligibleCollectionPost(post, ownerId) && !post.isNsfw)
    .sort((a, b) => b.post.createdAt.getTime() - a.post.createdAt.getTime())
    .flatMap(({ post }) => post.media.map((item) => item.url));

  return [...new Set(urls)].slice(0, 4);
}

export async function getLocalCollectionSummaries(ownerId: string) {
  const rows = await db.query.collections.findMany({
    where: { userId: ownerId },
    with: {
      memberships: {
        with: {
          post: {
            with: { media: true },
          },
        },
      },
    },
    orderBy: (collections, { asc, desc }) => [
      asc(collections.sortOrder),
      desc(collections.createdAt),
    ],
  });

  return rows.map((collection) => {
    const visibleMemberships = collection.memberships.filter(({ post }) => (
      eligibleCollectionPost(post, ownerId)
    ));
    return {
      id: collection.id,
      title: collection.title,
      description: collection.description,
      coverUrl: collection.coverUrl,
      previewImages: uniquePreviewImages(visibleMemberships, ownerId),
      postCount: visibleMemberships.length,
      createdAt: collection.createdAt.toISOString(),
      updatedAt: collection.updatedAt.toISOString(),
    };
  });
}

export async function getLocalCollectionDetail(
  ownerId: string,
  collectionId: string,
  viewerId?: string | null,
  options: { limit?: number; cursor?: string | null } = {},
) {
  const collection = await db.query.collections.findFirst({
    where: { AND: [{ id: collectionId }, { userId: ownerId }] },
  });
  if (!collection) return null;

  const memberships = await db.query.collectionPosts.findMany({
    where: { collectionId },
    with: {
      post: { with: collectionPostRelations },
    },
  });
  const allCollectionPosts = memberships
    .map(({ post }) => post)
    .filter((post) => eligibleCollectionPost(post, ownerId))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()) as LocalCollectionPost[];
  const limit = Math.max(1, Math.min(50, options.limit ?? 50));
  const cursorIndex = options.cursor
    ? allCollectionPosts.findIndex((post) => post.id === options.cursor)
    : -1;
  const pageStart = options.cursor
    ? cursorIndex >= 0 ? cursorIndex + 1 : allCollectionPosts.length
    : 0;
  let collectionPosts = allCollectionPosts.slice(pageStart, pageStart + limit);

  if (viewerId && collectionPosts.length > 0) {
    const postIds = collectionPosts.map((post) => post.id);
    const [viewerLikes, viewerReposts] = await Promise.all([
      db.query.likes.findMany({
        where: { AND: [{ userId: viewerId }, { postId: { in: postIds } }] },
      }),
      db.query.posts.findMany({
        where: {
          AND: [
            { userId: viewerId },
            { repostOfId: { in: postIds } },
            { isRemoved: false },
          ],
        },
      }),
    ]);
    const liked = new Set(viewerLikes.map((like) => like.postId));
    const reposted = new Set(viewerReposts.flatMap((post) => post.repostOfId ? [post.repostOfId] : []));
    collectionPosts = collectionPosts.map((post) => ({
      ...post,
      isLiked: liked.has(post.id),
      isReposted: reposted.has(post.id),
    }));
  }

  const previewImages = uniquePreviewImages(
    allCollectionPosts.map((post) => ({ post })),
    ownerId,
  );

  return {
    id: collection.id,
    title: collection.title,
    description: collection.description,
    coverUrl: collection.coverUrl,
    previewImages,
    postCount: allCollectionPosts.length,
    createdAt: collection.createdAt.toISOString(),
    updatedAt: collection.updatedAt.toISOString(),
    posts: collectionPosts,
    nextCursor: pageStart + collectionPosts.length < allCollectionPosts.length
      ? collectionPosts[collectionPosts.length - 1]?.id ?? null
      : null,
  };
}
