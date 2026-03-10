import { pgTable, text, timestamp, uuid, integer, bigint, boolean, index, foreignKey, uniqueIndex } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

// ============================================
// NODES
// ============================================

export const nodes = pgTable('nodes', {
  id: uuid('id').primaryKey().defaultRandom(),
  domain: text('domain').notNull().unique(),
  name: text('name').notNull(),
  description: text('description'),
  longDescription: text('long_description'),
  rules: text('rules'),
  bannerUrl: text('banner_url'),
  logoUrl: text('logo_url'),
  faviconUrl: text('favicon_url'),
  logoData: text('logo_data'), // Base64 encoded logo image
  faviconData: text('favicon_data'), // Base64 encoded favicon image
  accentColor: text('accent_color').default('#FFFFFF'),
  publicKey: text('public_key'),
  privateKeyEncrypted: text('private_key_encrypted'), // Encrypted with AUTH_SECRET
  // NSFW settings
  isNsfw: boolean('is_nsfw').default(false).notNull(), // Entire node is NSFW
  // Cloudflare Turnstile settings
  turnstileSiteKey: text('turnstile_site_key'),
  turnstileSecretKey: text('turnstile_secret_key'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// ============================================
// USERS
// ============================================

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  did: text('did').notNull().unique(), // Decentralized Identifier
  handle: text('handle').notNull().unique(), // @username (globally unique)
  email: text('email').unique(),
  passwordHash: text('password_hash'),
  displayName: text('display_name'),
  bio: text('bio'),
  avatarUrl: text('avatar_url'),
  headerUrl: text('header_url'),
  privateKeyEncrypted: text('private_key_encrypted'), // For cryptographic signing
  publicKey: text('public_key').notNull(),
  nodeId: uuid('node_id').references(() => nodes.id),
  // Bot-related fields
  isBot: boolean('is_bot').default(false).notNull(),
  botOwnerId: uuid('bot_owner_id'),
  // NSFW settings
  isNsfw: boolean('is_nsfw').default(false).notNull(), // Account produces NSFW content
  nsfwEnabled: boolean('nsfw_enabled').default(false).notNull(), // User wants to see NSFW content
  ageVerifiedAt: timestamp('age_verified_at'), // When user confirmed 18+
  // Moderation fields
  isSuspended: boolean('is_suspended').default(false).notNull(),
  suspensionReason: text('suspension_reason'),
  suspendedAt: timestamp('suspended_at'),
  isSilenced: boolean('is_silenced').default(false).notNull(),
  silenceReason: text('silence_reason'),
  silencedAt: timestamp('silenced_at'),
  // Account migration fields
  movedTo: text('moved_to'), // New actor URL if this account migrated away
  movedFrom: text('moved_from'), // Old actor URL if this account migrated here
  migratedAt: timestamp('migrated_at'), // When the migration occurred
  // User-owned S3-compatible storage - required for new users
  storageProvider: text('storage_provider'), // 's3', 'r2', 'b2', 'wasabi', 'contabo'
  storageEndpoint: text('storage_endpoint'), // S3 endpoint URL (optional for AWS)
  storagePublicBaseUrl: text('storage_public_base_url'), // Public URL for viewing files (required for R2, B2, Contabo)
  storageRegion: text('storage_region'), // Region (e.g., 'us-east-1')
  storageBucket: text('storage_bucket'), // Bucket name
  storageAccessKeyEncrypted: text('storage_access_key_encrypted'), // Encrypted access key
  storageSecretKeyEncrypted: text('storage_secret_key_encrypted'), // Encrypted secret key
  followersCount: integer('followers_count').default(0).notNull(),
  followingCount: integer('following_count').default(0).notNull(),
  postsCount: integer('posts_count').default(0).notNull(),
  website: text('website'),
  dmPrivacy: text('dm_privacy').default('everyone').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
  index('users_handle_idx').on(table.handle),
  index('users_did_idx').on(table.did),
  index('users_suspended_idx').on(table.isSuspended),
  index('users_silenced_idx').on(table.isSilenced),
  index('users_is_bot_idx').on(table.isBot),
  index('users_bot_owner_idx').on(table.botOwnerId),
  index('users_nsfw_idx').on(table.isNsfw),
  foreignKey({
    columns: [table.botOwnerId],
    foreignColumns: [table.id],
    name: 'users_bot_owner_id_users_id_fk'
  }).onDelete('cascade'),
]);

export const usersRelations = relations(users, ({ one, many }) => ({
  node: one(nodes, {
    fields: [users.nodeId],
    references: [nodes.id],
  }),
  botOwner: one(users, {
    fields: [users.botOwnerId],
    references: [users.id],
    relationName: 'ownedBots',
  }),
  ownedBotUsers: many(users, { relationName: 'ownedBots' }),
  posts: many(posts),
  followersRelation: many(follows, { relationName: 'following' }),
  followingRelation: many(follows, { relationName: 'follower' }),
}));

// ============================================
// POSTS
// ============================================

export const posts = pgTable('posts', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  botId: uuid('bot_id').references(() => bots.id, { onDelete: 'set null' }), // If posted by a bot
  content: text('content').notNull(),
  replyToId: uuid('reply_to_id'),
  repostOfId: uuid('repost_of_id'),
  // Swarm reply reference (when replying to a post on another node)
  swarmReplyToId: text('swarm_reply_to_id'), // Format: "swarm:domain:postId"
  swarmReplyToContent: text('swarm_reply_to_content'), // Cached content for display
  swarmReplyToAuthor: text('swarm_reply_to_author'), // JSON: {handle, displayName, avatarUrl, nodeDomain}
  likesCount: integer('likes_count').default(0).notNull(),
  repostsCount: integer('reposts_count').default(0).notNull(),
  repliesCount: integer('replies_count').default(0).notNull(),
  // NSFW
  isNsfw: boolean('is_nsfw').default(false).notNull(), // This specific post is NSFW
  // Moderation
  isRemoved: boolean('is_removed').default(false).notNull(),
  removedAt: timestamp('removed_at'),
  removedBy: uuid('removed_by').references(() => users.id),
  removedReason: text('removed_reason'),
  // Post identifiers
  apId: text('ap_id').unique(), // Unique post ID (legacy field, used for swarm posts too)
  apUrl: text('ap_url'), // Public URL for the post
  // Link Preview
  linkPreviewUrl: text('link_preview_url'),
  linkPreviewTitle: text('link_preview_title'),
  linkPreviewDescription: text('link_preview_description'),
  linkPreviewImage: text('link_preview_image'),
  linkPreviewType: text('link_preview_type'),
  linkPreviewVideoUrl: text('link_preview_video_url'),
  linkPreviewMediaJson: text('link_preview_media_json'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
  index('posts_user_id_idx').on(table.userId),
  index('posts_bot_id_idx').on(table.botId),
  index('posts_created_at_idx').on(table.createdAt),
  index('posts_reply_to_idx').on(table.replyToId),
  index('posts_removed_idx').on(table.isRemoved),
  index('posts_nsfw_idx').on(table.isNsfw),
]);

export const postsRelations = relations(posts, ({ one, many }) => ({
  author: one(users, {
    fields: [posts.userId],
    references: [users.id],
  }),
  bot: one(bots, {
    fields: [posts.botId],
    references: [bots.id],
  }),
  removedByUser: one(users, {
    fields: [posts.removedBy],
    references: [users.id],
  }),
  replyTo: one(posts, {
    fields: [posts.replyToId],
    references: [posts.id],
    relationName: 'replies',
  }),
  replies: many(posts, { relationName: 'replies' }),
  repostOf: one(posts, {
    fields: [posts.repostOfId],
    references: [posts.id],
    relationName: 'reposts',
  }),
  reposts: many(posts, { relationName: 'reposts' }),
  likes: many(likes),
  media: many(media),
}));

// ============================================
// MEDIA
// ============================================

export const media = pgTable('media', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  postId: uuid('post_id').references(() => posts.id, { onDelete: 'cascade' }),
  url: text('url').notNull(),
  altText: text('alt_text'),
  mimeType: text('mime_type'),
  width: integer('width'),
  height: integer('height'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  index('media_user_idx').on(table.userId),
  index('media_post_idx').on(table.postId),
]);

export const mediaRelations = relations(media, ({ one }) => ({
  user: one(users, {
    fields: [media.userId],
    references: [users.id],
  }),
  post: one(posts, {
    fields: [media.postId],
    references: [posts.id],
  }),
}));

// ============================================
// FOLLOWS
// ============================================

export const follows = pgTable('follows', {
  id: uuid('id').primaryKey().defaultRandom(),
  followerId: uuid('follower_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  followingId: uuid('following_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  // Follow identifiers
  apId: text('ap_id').unique(), // Activity ID (legacy field)
  pending: boolean('pending').default(false), // For follow requests
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  index('follows_follower_idx').on(table.followerId),
  index('follows_following_idx').on(table.followingId),
]);

export const followsRelations = relations(follows, ({ one }) => ({
  follower: one(users, {
    fields: [follows.followerId],
    references: [users.id],
    relationName: 'follower',
  }),
  following: one(users, {
    fields: [follows.followingId],
    references: [users.id],
    relationName: 'following',
  }),
}));

// ============================================
// REMOTE FOLLOWS (for federated follows)
// ============================================

export const remoteFollows = pgTable('remote_follows', {
  id: uuid('id').primaryKey().defaultRandom(),
  followerId: uuid('follower_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  targetHandle: text('target_handle').notNull(), // username@domain
  targetActorUrl: text('target_actor_url').notNull(),
  inboxUrl: text('inbox_url').notNull(),
  activityId: text('activity_id').notNull(), // UUID token for activity URL
  // Cached profile data for display
  displayName: text('display_name'),
  bio: text('bio'),
  avatarUrl: text('avatar_url'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  index('remote_follows_follower_idx').on(table.followerId),
  index('remote_follows_target_idx').on(table.targetHandle),
]);

// ============================================
// REMOTE FOLLOWERS (followers from federated instances)
// ============================================

export const remoteFollowers = pgTable('remote_followers', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }), // Local user being followed
  actorUrl: text('actor_url').notNull(), // Remote actor URL
  inboxUrl: text('inbox_url').notNull(), // Remote user's inbox
  sharedInboxUrl: text('shared_inbox_url'), // Optional shared inbox
  handle: text('handle'), // Remote user's handle (e.g., user@other-node.com)
  activityId: text('activity_id'), // The Follow activity ID
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  index('remote_followers_user_idx').on(table.userId),
  index('remote_followers_actor_idx').on(table.actorUrl),
  uniqueIndex('remote_followers_user_actor_unique').on(table.userId, table.actorUrl),
]);

// ============================================
// REMOTE POSTS (cached posts from federated users)
// ============================================

export const remotePosts = pgTable('remote_posts', {
  id: uuid('id').primaryKey().defaultRandom(),
  apId: text('ap_id').notNull().unique(), // Unique post ID (swarm:// or https://)
  authorHandle: text('author_handle').notNull(), // e.g., user@other-node.com
  authorActorUrl: text('author_actor_url').notNull(), // Remote actor URL
  authorDisplayName: text('author_display_name'),
  authorAvatarUrl: text('author_avatar_url'),
  content: text('content').notNull(),
  publishedAt: timestamp('published_at').notNull(), // Original publish time
  // Link preview
  linkPreviewUrl: text('link_preview_url'),
  linkPreviewTitle: text('link_preview_title'),
  linkPreviewDescription: text('link_preview_description'),
  linkPreviewImage: text('link_preview_image'),
  linkPreviewType: text('link_preview_type'),
  linkPreviewVideoUrl: text('link_preview_video_url'),
  linkPreviewMediaJson: text('link_preview_media_json'),
  // Media attachments stored as JSON
  mediaJson: text('media_json'), // JSON array of {url, altText}
  // Metadata
  fetchedAt: timestamp('fetched_at').defaultNow().notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  index('remote_posts_author_idx').on(table.authorHandle),
  index('remote_posts_published_idx').on(table.publishedAt),
  index('remote_posts_ap_id_idx').on(table.apId),
]);

// ============================================
// LIKES
// ============================================

export const likes = pgTable('likes', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  postId: uuid('post_id').notNull().references(() => posts.id, { onDelete: 'cascade' }),
  apId: text('ap_id').unique(), // Activity ID
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  index('likes_user_post_idx').on(table.userId, table.postId),
]);

export const likesRelations = relations(likes, ({ one }) => ({
  user: one(users, {
    fields: [likes.userId],
    references: [users.id],
  }),
  post: one(posts, {
    fields: [likes.postId],
    references: [posts.id],
  }),
}));

// ============================================
// REMOTE LIKES (likes from federated users on local posts)
// ============================================

export const remoteLikes = pgTable('remote_likes', {
  id: uuid('id').primaryKey().defaultRandom(),
  postId: uuid('post_id').notNull().references(() => posts.id, { onDelete: 'cascade' }),
  actorHandle: text('actor_handle').notNull(), // e.g., "user"
  actorNodeDomain: text('actor_node_domain').notNull(), // e.g., "other.node"
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  index('remote_likes_post_idx').on(table.postId),
  index('remote_likes_actor_idx').on(table.actorHandle, table.actorNodeDomain),
  uniqueIndex('remote_likes_unique').on(table.postId, table.actorHandle, table.actorNodeDomain),
]);

// ============================================
// USER SWARM LIKES (local users liking remote swarm posts)
// ============================================

export const userSwarmLikes = pgTable('user_swarm_likes', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  nodeDomain: text('node_domain').notNull(),
  originalPostId: text('original_post_id').notNull(),
  authorHandle: text('author_handle').notNull(),
  authorDisplayName: text('author_display_name'),
  authorAvatarUrl: text('author_avatar_url'),
  content: text('content').notNull(),
  postCreatedAt: timestamp('post_created_at').notNull(),
  likesCount: integer('likes_count').default(0).notNull(),
  repostsCount: integer('reposts_count').default(0).notNull(),
  repliesCount: integer('replies_count').default(0).notNull(),
  linkPreviewUrl: text('link_preview_url'),
  linkPreviewTitle: text('link_preview_title'),
  linkPreviewDescription: text('link_preview_description'),
  linkPreviewImage: text('link_preview_image'),
  linkPreviewType: text('link_preview_type'),
  linkPreviewVideoUrl: text('link_preview_video_url'),
  linkPreviewMediaJson: text('link_preview_media_json'),
  mediaJson: text('media_json'),
  likedAt: timestamp('liked_at').defaultNow().notNull(),
}, (table) => [
  index('user_swarm_likes_user_idx').on(table.userId, table.likedAt),
  index('user_swarm_likes_post_idx').on(table.nodeDomain, table.originalPostId),
  uniqueIndex('user_swarm_likes_unique').on(table.userId, table.nodeDomain, table.originalPostId),
]);

// ============================================
// USER SWARM REPOSTS (local users reposting remote swarm posts)
// ============================================

export const userSwarmReposts = pgTable('user_swarm_reposts', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  nodeDomain: text('node_domain').notNull(),
  originalPostId: text('original_post_id').notNull(),
  authorHandle: text('author_handle').notNull(),
  authorDisplayName: text('author_display_name'),
  authorAvatarUrl: text('author_avatar_url'),
  content: text('content').notNull(),
  postCreatedAt: timestamp('post_created_at').notNull(),
  likesCount: integer('likes_count').default(0).notNull(),
  repostsCount: integer('reposts_count').default(0).notNull(),
  repliesCount: integer('replies_count').default(0).notNull(),
  linkPreviewUrl: text('link_preview_url'),
  linkPreviewTitle: text('link_preview_title'),
  linkPreviewDescription: text('link_preview_description'),
  linkPreviewImage: text('link_preview_image'),
  linkPreviewType: text('link_preview_type'),
  linkPreviewVideoUrl: text('link_preview_video_url'),
  linkPreviewMediaJson: text('link_preview_media_json'),
  mediaJson: text('media_json'),
  repostedAt: timestamp('reposted_at').defaultNow().notNull(),
}, (table) => [
  index('user_swarm_reposts_user_idx').on(table.userId, table.repostedAt),
  index('user_swarm_reposts_post_idx').on(table.nodeDomain, table.originalPostId),
  uniqueIndex('user_swarm_reposts_unique').on(table.userId, table.nodeDomain, table.originalPostId),
]);

// ============================================
// REMOTE REPOSTS (reposts from federated users on local posts)
// ============================================

export const remoteReposts = pgTable('remote_reposts', {
  id: uuid('id').primaryKey().defaultRandom(),
  postId: uuid('post_id').notNull().references(() => posts.id, { onDelete: 'cascade' }),
  actorHandle: text('actor_handle').notNull(),
  actorNodeDomain: text('actor_node_domain').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  index('remote_reposts_post_idx').on(table.postId),
  index('remote_reposts_actor_idx').on(table.actorHandle, table.actorNodeDomain),
  uniqueIndex('remote_reposts_unique').on(table.postId, table.actorHandle, table.actorNodeDomain),
]);

// ============================================
// NOTIFICATIONS
// ============================================

export const notifications = pgTable('notifications', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  // Actor info - stored directly instead of referencing placeholder users
  actorId: uuid('actor_id').references(() => users.id, { onDelete: 'cascade' }), // Optional - only for local actors
  actorHandle: text('actor_handle').notNull(), // e.g., "user" or "user@remote.node"
  actorDisplayName: text('actor_display_name'),
  actorAvatarUrl: text('actor_avatar_url'),
  actorNodeDomain: text('actor_node_domain'), // null for local actors
  // Target info - used for owner-shadow notifications like interactions with owned bots
  targetHandle: text('target_handle'),
  targetDisplayName: text('target_display_name'),
  targetAvatarUrl: text('target_avatar_url'),
  targetNodeDomain: text('target_node_domain'),
  targetIsBot: boolean('target_is_bot'),
  // Post reference
  postId: uuid('post_id').references(() => posts.id, { onDelete: 'cascade' }),
  postContent: text('post_content'), // Cached content for display
  type: text('type').notNull(), // follow | like | repost | mention
  readAt: timestamp('read_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  index('notifications_user_idx').on(table.userId),
  index('notifications_created_idx').on(table.createdAt),
]);

export const notificationsRelations = relations(notifications, ({ one }) => ({
  recipient: one(users, {
    fields: [notifications.userId],
    references: [users.id],
    relationName: 'recipient',
  }),
  actor: one(users, {
    fields: [notifications.actorId],
    references: [users.id],
    relationName: 'actor',
  }),
  post: one(posts, {
    fields: [notifications.postId],
    references: [posts.id],
  }),
}));

// ============================================
// HANDLE REGISTRY (for federated handle resolution)
// ============================================

export const handleRegistry = pgTable('handle_registry', {
  handle: text('handle').primaryKey(), // @username
  did: text('did').notNull(),
  nodeDomain: text('node_domain').notNull(),
  registeredAt: timestamp('registered_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
  index('handle_registry_updated_idx').on(table.updatedAt),
]);

// ============================================
// SESSIONS (for auth)
// ============================================

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  token: text('token').notNull().unique(),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  index('sessions_token_idx').on(table.token),
  index('sessions_user_idx').on(table.userId),
]);

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, {
    fields: [sessions.userId],
    references: [users.id],
  }),
}));

// ============================================
// BLOCKS & MUTES (user-level moderation)
// ============================================

export const blocks = pgTable('blocks', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  blockedUserId: uuid('blocked_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  index('blocks_user_idx').on(table.userId),
  index('blocks_blocked_user_idx').on(table.blockedUserId),
]);

export const blocksRelations = relations(blocks, ({ one }) => ({
  user: one(users, {
    fields: [blocks.userId],
    references: [users.id],
  }),
  blockedUser: one(users, {
    fields: [blocks.blockedUserId],
    references: [users.id],
  }),
}));

export const mutes = pgTable('mutes', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  mutedUserId: uuid('muted_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  index('mutes_user_idx').on(table.userId),
  index('mutes_muted_user_idx').on(table.mutedUserId),
]);

export const mutesRelations = relations(mutes, ({ one }) => ({
  user: one(users, {
    fields: [mutes.userId],
    references: [users.id],
  }),
  mutedUser: one(users, {
    fields: [mutes.mutedUserId],
    references: [users.id],
  }),
}));

// Muted nodes - hide all content from specific swarm nodes
export const mutedNodes = pgTable('muted_nodes', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  nodeDomain: text('node_domain').notNull(), // Domain of the muted node
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  index('muted_nodes_user_idx').on(table.userId),
  index('muted_nodes_domain_idx').on(table.nodeDomain),
]);

export const mutedNodesRelations = relations(mutedNodes, ({ one }) => ({
  user: one(users, {
    fields: [mutedNodes.userId],
    references: [users.id],
  }),
}));

// ============================================
// REPORTS (moderation)
// ============================================

export const reports = pgTable('reports', {
  id: uuid('id').primaryKey().defaultRandom(),
  reporterId: uuid('reporter_id').references(() => users.id, { onDelete: 'set null' }),
  targetType: text('target_type').notNull(), // 'post' | 'user'
  targetId: uuid('target_id').notNull(),
  reason: text('reason').notNull(),
  status: text('status').default('open').notNull(), // open | resolved
  resolvedAt: timestamp('resolved_at'),
  resolvedBy: uuid('resolved_by').references(() => users.id),
  resolutionNote: text('resolution_note'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  index('reports_status_idx').on(table.status),
  index('reports_target_idx').on(table.targetType, table.targetId),
  index('reports_reporter_idx').on(table.reporterId),
]);

export const reportsRelations = relations(reports, ({ one }) => ({
  reporter: one(users, {
    fields: [reports.reporterId],
    references: [users.id],
  }),
  resolver: one(users, {
    fields: [reports.resolvedBy],
    references: [users.id],
  }),
}));


// ============================================
// BOTS
// ============================================

export const bots = pgTable('bots', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }), // The bot's own user account
  ownerId: uuid('owner_id').notNull().references(() => users.id, { onDelete: 'cascade' }), // The human who manages this bot
  name: text('name').notNull(),

  // Personality configuration (JSON)
  personalityConfig: text('personality_config').notNull(), // JSON

  // LLM configuration
  llmProvider: text('llm_provider').notNull(), // openrouter, openai, anthropic, custom
  llmModel: text('llm_model').notNull(),
  llmEndpoint: text('llm_endpoint'),
  llmApiKeyEncrypted: text('llm_api_key_encrypted').notNull(),

  // Scheduling
  scheduleConfig: text('schedule_config'), // JSON
  autonomousMode: boolean('autonomous_mode').default(false).notNull(),

  // Status
  isActive: boolean('is_active').default(true).notNull(),
  isSuspended: boolean('is_suspended').default(false).notNull(),
  suspensionReason: text('suspension_reason'),
  suspendedAt: timestamp('suspended_at'),

  // Timestamps
  lastPostAt: timestamp('last_post_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
  index('bots_user_id_idx').on(table.userId),
  index('bots_owner_id_idx').on(table.ownerId),
  index('bots_active_idx').on(table.isActive),
]);

export const botsRelations = relations(bots, ({ one, many }) => ({
  user: one(users, {
    fields: [bots.userId],
    references: [users.id],
    relationName: 'botUser',
  }),
  owner: one(users, {
    fields: [bots.ownerId],
    references: [users.id],
    relationName: 'botOwner',
  }),
  contentSources: many(botContentSources),
  mentions: many(botMentions),
  activityLogs: many(botActivityLogs),
  rateLimits: many(botRateLimits),
}));

// ============================================
// BOT CONTENT SOURCES
// ============================================

export const botContentSources = pgTable('bot_content_sources', {
  id: uuid('id').primaryKey().defaultRandom(),
  botId: uuid('bot_id').notNull().references(() => bots.id, { onDelete: 'cascade' }),

  type: text('type').notNull(), // rss, reddit, news_api, brave_news
  url: text('url').notNull(),
  subreddit: text('subreddit'), // For Reddit sources
  apiKeyEncrypted: text('api_key_encrypted'), // For news APIs
  sourceConfig: text('source_config'), // JSON config for brave_news, news_api query builder

  keywords: text('keywords'), // JSON array for filtering

  isActive: boolean('is_active').default(true).notNull(),
  lastFetchAt: timestamp('last_fetch_at'),
  lastError: text('last_error'),
  consecutiveErrors: integer('consecutive_errors').default(0).notNull(),

  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
  index('bot_content_sources_bot_idx').on(table.botId),
  index('bot_content_sources_type_idx').on(table.type),
]);

export const botContentSourcesRelations = relations(botContentSources, ({ one, many }) => ({
  bot: one(bots, {
    fields: [botContentSources.botId],
    references: [bots.id],
  }),
  contentItems: many(botContentItems),
}));

// ============================================
// BOT CONTENT ITEMS
// ============================================

export const botContentItems = pgTable('bot_content_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  sourceId: uuid('source_id').notNull().references(() => botContentSources.id, { onDelete: 'cascade' }),

  externalId: text('external_id').notNull(), // Unique ID from source
  title: text('title').notNull(),
  content: text('content'),
  url: text('url').notNull(),

  publishedAt: timestamp('published_at').notNull(),
  fetchedAt: timestamp('fetched_at').defaultNow().notNull(),

  isProcessed: boolean('is_processed').default(false).notNull(),
  processedAt: timestamp('processed_at'),
  postId: uuid('post_id').references(() => posts.id, { onDelete: 'set null' }), // If a post was created

  interestScore: integer('interest_score'), // LLM evaluation score
  interestReason: text('interest_reason'),
}, (table) => [
  index('bot_content_items_source_idx').on(table.sourceId),
  index('bot_content_items_processed_idx').on(table.isProcessed),
  index('bot_content_items_external_idx').on(table.externalId),
]);

export const botContentItemsRelations = relations(botContentItems, ({ one }) => ({
  source: one(botContentSources, {
    fields: [botContentItems.sourceId],
    references: [botContentSources.id],
  }),
  post: one(posts, {
    fields: [botContentItems.postId],
    references: [posts.id],
  }),
}));

// ============================================
// BOT MENTIONS
// ============================================

export const botMentions = pgTable('bot_mentions', {
  id: uuid('id').primaryKey().defaultRandom(),
  botId: uuid('bot_id').notNull().references(() => bots.id, { onDelete: 'cascade' }),
  postId: uuid('post_id').notNull().references(() => posts.id, { onDelete: 'cascade' }),

  authorId: uuid('author_id').notNull().references(() => users.id),
  content: text('content').notNull(),

  isProcessed: boolean('is_processed').default(false).notNull(),
  processedAt: timestamp('processed_at'),
  responsePostId: uuid('response_post_id').references(() => posts.id),

  // For federated mentions
  isRemote: boolean('is_remote').default(false).notNull(),
  remoteActorUrl: text('remote_actor_url'),

  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  index('bot_mentions_bot_idx').on(table.botId),
  index('bot_mentions_processed_idx').on(table.isProcessed),
  index('bot_mentions_created_idx').on(table.createdAt),
]);

export const botMentionsRelations = relations(botMentions, ({ one }) => ({
  bot: one(bots, {
    fields: [botMentions.botId],
    references: [bots.id],
  }),
  post: one(posts, {
    fields: [botMentions.postId],
    references: [posts.id],
  }),
  author: one(users, {
    fields: [botMentions.authorId],
    references: [users.id],
  }),
  responsePost: one(posts, {
    fields: [botMentions.responsePostId],
    references: [posts.id],
  }),
}));

// ============================================
// BOT ACTIVITY LOGS
// ============================================

export const botActivityLogs = pgTable('bot_activity_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  botId: uuid('bot_id').notNull().references(() => bots.id, { onDelete: 'cascade' }),

  action: text('action').notNull(), // post_created, mention_response, etc.
  details: text('details').notNull(), // JSON

  success: boolean('success').notNull(),
  errorMessage: text('error_message'),

  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  index('bot_activity_logs_bot_idx').on(table.botId),
  index('bot_activity_logs_action_idx').on(table.action),
  index('bot_activity_logs_created_idx').on(table.createdAt),
]);

export const botActivityLogsRelations = relations(botActivityLogs, ({ one }) => ({
  bot: one(bots, {
    fields: [botActivityLogs.botId],
    references: [bots.id],
  }),
}));

// ============================================
// BOT RATE LIMITS
// ============================================

export const botRateLimits = pgTable('bot_rate_limits', {
  id: uuid('id').primaryKey().defaultRandom(),
  botId: uuid('bot_id').notNull().references(() => bots.id, { onDelete: 'cascade' }),

  windowStart: timestamp('window_start').notNull(),
  windowType: text('window_type').notNull(), // daily, hourly
  postCount: integer('post_count').default(0).notNull(),
  replyCount: integer('reply_count').default(0).notNull(),

  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  index('bot_rate_limits_bot_window_idx').on(table.botId, table.windowStart),
]);

export const botRateLimitsRelations = relations(botRateLimits, ({ one }) => ({
  bot: one(bots, {
    fields: [botRateLimits.botId],
    references: [bots.id],
  }),
}));

// ============================================
// SWARM - Node Discovery Network
// ============================================

/**
 * Discovered nodes in the swarm network.
 * Tracks all known Synapsis nodes discovered through gossip or seed nodes.
 */
export const swarmNodes = pgTable('swarm_nodes', {
  id: uuid('id').primaryKey().defaultRandom(),
  domain: text('domain').notNull().unique(),

  // Node metadata (fetched from remote)
  name: text('name'),
  description: text('description'),
  logoUrl: text('logo_url'),
  publicKey: text('public_key'),
  softwareVersion: text('software_version'),

  // Stats (updated periodically)
  userCount: integer('user_count'),
  postCount: integer('post_count'),

  // NSFW flag (synced from remote node)
  isNsfw: boolean('is_nsfw').default(false).notNull(),

  // Discovery metadata
  discoveredVia: text('discovered_via'), // Domain of node that told us about this one
  discoveredAt: timestamp('discovered_at').defaultNow().notNull(),

  // Health tracking
  lastSeenAt: timestamp('last_seen_at').defaultNow().notNull(),
  lastSyncAt: timestamp('last_sync_at'),
  consecutiveFailures: integer('consecutive_failures').default(0).notNull(),
  isActive: boolean('is_active').default(true).notNull(),

  // Trust/reputation (for future spam prevention)
  trustScore: integer('trust_score').default(50).notNull(), // 0-100

  // Admin moderation
  isBlocked: boolean('is_blocked').default(false).notNull(),
  blockReason: text('block_reason'),
  blockedAt: timestamp('blocked_at'),

  // Capabilities
  capabilities: text('capabilities'), // JSON array: ["handles", "gossip", "relay"]

  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
  index('swarm_nodes_domain_idx').on(table.domain),
  index('swarm_nodes_active_idx').on(table.isActive),
  index('swarm_nodes_last_seen_idx').on(table.lastSeenAt),
  index('swarm_nodes_trust_idx').on(table.trustScore),
  index('swarm_nodes_nsfw_idx').on(table.isNsfw),
  index('swarm_nodes_blocked_idx').on(table.isBlocked),
]);

/**
 * Seed nodes - well-known entry points to the swarm.
 * These are the bootstrap nodes that new nodes contact first.
 */
export const swarmSeeds = pgTable('swarm_seeds', {
  id: uuid('id').primaryKey().defaultRandom(),
  domain: text('domain').notNull().unique(),

  // Priority for connection order (lower = higher priority)
  priority: integer('priority').default(100).notNull(),

  // Whether this seed is enabled
  isEnabled: boolean('is_enabled').default(true).notNull(),

  // Health tracking
  lastContactAt: timestamp('last_contact_at'),
  consecutiveFailures: integer('consecutive_failures').default(0).notNull(),

  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  index('swarm_seeds_enabled_idx').on(table.isEnabled),
  index('swarm_seeds_priority_idx').on(table.priority),
]);

/**
 * Swarm sync log - tracks gossip exchanges between nodes.
 */
export const swarmSyncLog = pgTable('swarm_sync_log', {
  id: uuid('id').primaryKey().defaultRandom(),

  // Which node we synced with
  remoteDomain: text('remote_domain').notNull(),

  // Direction: 'push' (we sent) or 'pull' (we received)
  direction: text('direction').notNull(),

  // What was synced
  nodesReceived: integer('nodes_received').default(0).notNull(),
  nodesSent: integer('nodes_sent').default(0).notNull(),
  handlesReceived: integer('handles_received').default(0).notNull(),
  handlesSent: integer('handles_sent').default(0).notNull(),

  // Result
  success: boolean('success').notNull(),
  errorMessage: text('error_message'),
  durationMs: integer('duration_ms'),

  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  index('swarm_sync_log_remote_idx').on(table.remoteDomain),
  index('swarm_sync_log_created_idx').on(table.createdAt),
]);

// ============================================
// SWARM CHAT
// ============================================

/**
 * Chat conversations between users across the swarm.
 * Each conversation has a unique ID and tracks participants.
 */
export const chatConversations = pgTable('chat_conversations', {
  id: uuid('id').primaryKey().defaultRandom(),

  // Conversation type: 'direct' (1-on-1) or 'group' (future)
  type: text('type').default('direct').notNull(),

  // For direct chats, store both participants
  participant1Id: uuid('participant1_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  participant2Handle: text('participant2_handle').notNull(), // Can be local or remote (user@domain)

  // Last message info for sorting
  lastMessageAt: timestamp('last_message_at'),
  lastMessagePreview: text('last_message_preview'),

  // Metadata
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
  index('chat_conversations_participant1_idx').on(table.participant1Id),
  index('chat_conversations_last_message_idx').on(table.lastMessageAt),
  // Ensure unique conversation between two users
  uniqueIndex('chat_conversations_unique').on(table.participant1Id, table.participant2Handle),
]);

export const chatConversationsRelations = relations(chatConversations, ({ one, many }) => ({
  participant1: one(users, {
    fields: [chatConversations.participant1Id],
    references: [users.id],
  }),
  messages: many(chatMessages),
}));

/**
 * Individual chat messages within conversations.
 * Messages are stored as plain text on the server.
 * Both sender and recipient can view the message content.
 */
export const chatMessages = pgTable('chat_messages', {
  id: uuid('id').primaryKey().defaultRandom(),

  // Which conversation this belongs to
  conversationId: uuid('conversation_id').notNull().references(() => chatConversations.id, { onDelete: 'cascade' }),

  // Sender info
  senderHandle: text('sender_handle').notNull(), // Can be local or remote
  senderDisplayName: text('sender_display_name'),
  senderAvatarUrl: text('sender_avatar_url'),
  senderNodeDomain: text('sender_node_domain'), // null if local
  senderDid: text('sender_did'), // DID for Signal Protocol

  // Message content (plain text for verified chat)
  content: text('content'),

  // Swarm sync info
  swarmMessageId: text('swarm_message_id').unique(), // Format: swarm:domain:uuid

  // Status tracking
  deliveredAt: timestamp('delivered_at'),
  readAt: timestamp('read_at'),

  // Metadata
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  index('chat_messages_conversation_idx').on(table.conversationId),
  index('chat_messages_created_idx').on(table.createdAt),
  index('chat_messages_swarm_id_idx').on(table.swarmMessageId),
]);

export const chatMessagesRelations = relations(chatMessages, ({ one }) => ({
  conversation: one(chatConversations, {
    fields: [chatMessages.conversationId],
    references: [chatConversations.id],
  }),
}));



/**
 * Typing indicators for real-time chat UX.
 * Short-lived records that expire after 10 seconds.
 */
export const chatTypingIndicators = pgTable('chat_typing_indicators', {
  id: uuid('id').primaryKey().defaultRandom(),

  conversationId: uuid('conversation_id').notNull().references(() => chatConversations.id, { onDelete: 'cascade' }),
  userHandle: text('user_handle').notNull(),

  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  index('chat_typing_conversation_idx').on(table.conversationId),
  index('chat_typing_expires_idx').on(table.expiresAt),
  uniqueIndex('chat_typing_unique').on(table.conversationId, table.userHandle),
]);

// ============================================
// CRYPTO & SECURITY
// ============================================

/**
 * Replay protection for signed user actions.
 * Enforces uniqueness of (did, nonce) within the valid timeframe.
 */
export const signedActionDedupe = pgTable('signed_action_dedupe', {
  // SHA-256 of canonical signed payload (without signature)
  actionId: text('action_id').primaryKey(),

  did: text('did').notNull(),
  nonce: text('nonce').notNull(),
  ts: bigint('ts', { mode: 'number' }).notNull(),

  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  index('signed_action_dedupe_created_idx').on(table.createdAt), // For cleanup
]);

/**
 * Cache for remote public keys to enforce key continuity.
 * Prevents TOFU (Trust On First Use) attacks after initial trust.
 */
export const remoteIdentityCache = pgTable('remote_identity_cache', {
  did: text('did').primaryKey(), // The DID is the key
  publicKey: text('public_key').notNull(),

  fetchedAt: timestamp('fetched_at').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
});
