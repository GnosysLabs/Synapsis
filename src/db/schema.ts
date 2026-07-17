import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

const currentTimestamp = sql`(unixepoch())`;

// ============================================
// NODES
// ============================================

export const nodes = sqliteTable('nodes', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
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
  isNsfw: integer('is_nsfw', { mode: 'boolean' }).default(false).notNull(), // Permanent adult-only node classification
  nsfwActivatedAt: integer('nsfw_activated_at', { mode: 'timestamp' }), // Exact boundary between pre-conversion and adult-node registrations
  // Cloudflare Turnstile settings
  turnstileSiteKey: text('turnstile_site_key'),
  turnstileSecretKey: text('turnstile_secret_key'),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(currentTimestamp).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).default(currentTimestamp).notNull(),
});

// ============================================
// USERS
// ============================================

export const users = sqliteTable('users', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
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
  nodeId: text('node_id').references(() => nodes.id),
  // NSFW settings
  isNsfw: integer('is_nsfw', { mode: 'boolean' }).default(false).notNull(), // Account produces NSFW content
  nsfwEnabled: integer('nsfw_enabled', { mode: 'boolean' }).default(false).notNull(), // User wants to see NSFW content
  ageVerifiedAt: integer('age_verified_at', { mode: 'timestamp' }), // When user confirmed 18+
  // Moderation fields
  isSuspended: integer('is_suspended', { mode: 'boolean' }).default(false).notNull(),
  suspensionReason: text('suspension_reason'),
  suspendedAt: integer('suspended_at', { mode: 'timestamp' }),
  isSilenced: integer('is_silenced', { mode: 'boolean' }).default(false).notNull(),
  silenceReason: text('silence_reason'),
  silencedAt: integer('silenced_at', { mode: 'timestamp' }),
  // Account migration fields
  movedTo: text('moved_to'), // New actor URL if this account migrated away
  movedFrom: text('moved_from'), // Old actor URL if this account migrated here
  migratedAt: integer('migrated_at', { mode: 'timestamp' }), // When the migration occurred
  // Legacy S3 fields retained so upgrades do not require a destructive table rebuild.
  // New media storage connections use Stuffbox exclusively.
  storageProvider: text('storage_provider'),
  storageEndpoint: text('storage_endpoint'),
  storagePublicBaseUrl: text('storage_public_base_url'),
  storageRegion: text('storage_region'),
  storageBucket: text('storage_bucket'),
  storageAccessKeyEncrypted: text('storage_access_key_encrypted'),
  storageSecretKeyEncrypted: text('storage_secret_key_encrypted'),
  followersCount: integer('followers_count').default(0).notNull(),
  followingCount: integer('following_count').default(0).notNull(),
  postsCount: integer('posts_count').default(0).notNull(),
  website: text('website'),
  dmPrivacy: text('dm_privacy').default('everyone').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(currentTimestamp).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).default(currentTimestamp).notNull(),
}, (table) => [
  index('users_handle_idx').on(table.handle),
  index('users_did_idx').on(table.did),
  uniqueIndex('users_handle_unique_idx').on(table.handle),
  uniqueIndex('users_did_unique_idx').on(table.did),
  index('users_suspended_idx').on(table.isSuspended),
  index('users_silenced_idx').on(table.isSilenced),
  index('users_nsfw_idx').on(table.isNsfw),
]);

// ============================================
// STUFFBOX CONNECTIONS
// ============================================

export const stuffboxConnections = sqliteTable('stuffbox_connections', {
  userId: text('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  baseUrl: text('base_url').notNull(),
  accessTokenEncrypted: text('access_token_encrypted').notNull(),
  accessTokenExpiresAt: integer('access_token_expires_at', { mode: 'timestamp' }).notNull(),
  refreshTokenEncrypted: text('refresh_token_encrypted').notNull(),
  refreshTokenExpiresAt: integer('refresh_token_expires_at', { mode: 'timestamp' }),
  scopes: text('scopes').notNull(),
  connectedAt: integer('connected_at', { mode: 'timestamp' }).default(currentTimestamp).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).default(currentTimestamp).notNull(),
});


// ============================================
// POSTS
// ============================================

export const posts = sqliteTable('posts', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  content: text('content').notNull(),
  replyToId: text('reply_to_id'),
  repostOfId: text('repost_of_id'),
  // Swarm reply reference (when replying to a post on another node)
  swarmReplyToId: text('swarm_reply_to_id'), // Format: "swarm:domain:postId"
  swarmReplyToContent: text('swarm_reply_to_content'), // Cached content for display
  swarmReplyToAuthor: text('swarm_reply_to_author'), // JSON: {handle, displayName, avatarUrl, nodeDomain}
  likesCount: integer('likes_count').default(0).notNull(),
  repostsCount: integer('reposts_count').default(0).notNull(),
  repliesCount: integer('replies_count').default(0).notNull(),
  // NSFW
  isNsfw: integer('is_nsfw', { mode: 'boolean' }).default(false).notNull(), // This specific post is NSFW
  // Moderation
  isRemoved: integer('is_removed', { mode: 'boolean' }).default(false).notNull(),
  removedAt: integer('removed_at', { mode: 'timestamp' }),
  removedBy: text('removed_by').references(() => users.id),
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
  createdAt: integer('created_at', { mode: 'timestamp' }).default(currentTimestamp).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).default(currentTimestamp).notNull(),
}, (table) => [
  index('posts_user_id_idx').on(table.userId),
  index('posts_created_at_idx').on(table.createdAt),
  index('posts_reply_to_idx').on(table.replyToId),
  index('posts_removed_idx').on(table.isRemoved),
  index('posts_nsfw_idx').on(table.isNsfw),
]);


// ============================================
// MEDIA
// ============================================

export const media = sqliteTable('media', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  postId: text('post_id').references(() => posts.id, { onDelete: 'cascade' }),
  url: text('url').notNull(),
  storageProvider: text('storage_provider'),
  storageAssetId: text('storage_asset_id'),
  altText: text('alt_text'),
  mimeType: text('mime_type'),
  width: integer('width'),
  height: integer('height'),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(currentTimestamp).notNull(),
}, (table) => [
  index('media_user_idx').on(table.userId),
  index('media_post_idx').on(table.postId),
]);


// ============================================
// FOLLOWS
// ============================================

export const follows = sqliteTable('follows', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  followerId: text('follower_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  followingId: text('following_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  // Follow identifiers
  apId: text('ap_id').unique(), // Activity ID (legacy field)
  pending: integer('pending', { mode: 'boolean' }).default(false), // For follow requests
  createdAt: integer('created_at', { mode: 'timestamp' }).default(currentTimestamp).notNull(),
}, (table) => [
  index('follows_follower_idx').on(table.followerId),
  index('follows_following_idx').on(table.followingId),
]);


// ============================================
// REMOTE FOLLOWS (for federated follows)
// ============================================

export const remoteFollows = sqliteTable('remote_follows', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  followerId: text('follower_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  targetHandle: text('target_handle').notNull(), // username@domain
  targetActorUrl: text('target_actor_url').notNull(),
  inboxUrl: text('inbox_url').notNull(),
  activityId: text('activity_id').notNull(), // UUID token for activity URL
  // Cached profile data for display
  displayName: text('display_name'),
  bio: text('bio'),
  avatarUrl: text('avatar_url'),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(currentTimestamp).notNull(),
}, (table) => [
  index('remote_follows_follower_idx').on(table.followerId),
  index('remote_follows_target_idx').on(table.targetHandle),
]);

// ============================================
// REMOTE FOLLOWERS (followers from federated instances)
// ============================================

export const remoteFollowers = sqliteTable('remote_followers', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }), // Local user being followed
  actorUrl: text('actor_url').notNull(), // Remote actor URL
  inboxUrl: text('inbox_url').notNull(), // Remote user's inbox
  sharedInboxUrl: text('shared_inbox_url'), // Optional shared inbox
  handle: text('handle'), // Remote user's handle (e.g., user@other-node.com)
  activityId: text('activity_id'), // The Follow activity ID
  createdAt: integer('created_at', { mode: 'timestamp' }).default(currentTimestamp).notNull(),
}, (table) => [
  index('remote_followers_user_idx').on(table.userId),
  index('remote_followers_actor_idx').on(table.actorUrl),
  uniqueIndex('remote_followers_user_actor_unique').on(table.userId, table.actorUrl),
]);

// ============================================
// REMOTE POSTS (cached posts from federated users)
// ============================================

export const remotePosts = sqliteTable('remote_posts', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  apId: text('ap_id').notNull().unique(), // Unique post ID (swarm:// or https://)
  authorHandle: text('author_handle').notNull(), // e.g., user@other-node.com
  authorActorUrl: text('author_actor_url').notNull(), // Remote actor URL
  authorDisplayName: text('author_display_name'),
  authorAvatarUrl: text('author_avatar_url'),
  content: text('content').notNull(),
  publishedAt: integer('published_at', { mode: 'timestamp' }).notNull(), // Original publish time
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
  fetchedAt: integer('fetched_at', { mode: 'timestamp' }).default(currentTimestamp).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(currentTimestamp).notNull(),
}, (table) => [
  index('remote_posts_author_idx').on(table.authorHandle),
  index('remote_posts_published_idx').on(table.publishedAt),
  index('remote_posts_ap_id_idx').on(table.apId),
]);

// ============================================
// LIKES
// ============================================

export const likes = sqliteTable('likes', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  postId: text('post_id').notNull().references(() => posts.id, { onDelete: 'cascade' }),
  apId: text('ap_id').unique(), // Activity ID
  createdAt: integer('created_at', { mode: 'timestamp' }).default(currentTimestamp).notNull(),
}, (table) => [
  index('likes_user_post_idx').on(table.userId, table.postId),
]);


// ============================================
// REMOTE LIKES (likes from federated users on local posts)
// ============================================

export const remoteLikes = sqliteTable('remote_likes', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  postId: text('post_id').notNull().references(() => posts.id, { onDelete: 'cascade' }),
  actorHandle: text('actor_handle').notNull(), // e.g., "user"
  actorNodeDomain: text('actor_node_domain').notNull(), // e.g., "other.node"
  createdAt: integer('created_at', { mode: 'timestamp' }).default(currentTimestamp).notNull(),
}, (table) => [
  index('remote_likes_post_idx').on(table.postId),
  index('remote_likes_actor_idx').on(table.actorHandle, table.actorNodeDomain),
  uniqueIndex('remote_likes_unique').on(table.postId, table.actorHandle, table.actorNodeDomain),
]);

// ============================================
// USER SWARM LIKES (local users liking remote swarm posts)
// ============================================

export const userSwarmLikes = sqliteTable('user_swarm_likes', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  nodeDomain: text('node_domain').notNull(),
  originalPostId: text('original_post_id').notNull(),
  authorHandle: text('author_handle').notNull(),
  authorDisplayName: text('author_display_name'),
  authorAvatarUrl: text('author_avatar_url'),
  content: text('content').notNull(),
  postCreatedAt: integer('post_created_at', { mode: 'timestamp' }).notNull(),
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
  likedAt: integer('liked_at', { mode: 'timestamp' }).default(currentTimestamp).notNull(),
}, (table) => [
  index('user_swarm_likes_user_idx').on(table.userId, table.likedAt),
  index('user_swarm_likes_post_idx').on(table.nodeDomain, table.originalPostId),
  uniqueIndex('user_swarm_likes_unique').on(table.userId, table.nodeDomain, table.originalPostId),
]);

// ============================================
// USER SWARM REPOSTS (local users reposting remote swarm posts)
// ============================================

export const userSwarmReposts = sqliteTable('user_swarm_reposts', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  nodeDomain: text('node_domain').notNull(),
  originalPostId: text('original_post_id').notNull(),
  authorHandle: text('author_handle').notNull(),
  authorDisplayName: text('author_display_name'),
  authorAvatarUrl: text('author_avatar_url'),
  content: text('content').notNull(),
  postCreatedAt: integer('post_created_at', { mode: 'timestamp' }).notNull(),
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
  repostedAt: integer('reposted_at', { mode: 'timestamp' }).default(currentTimestamp).notNull(),
}, (table) => [
  index('user_swarm_reposts_user_idx').on(table.userId, table.repostedAt),
  index('user_swarm_reposts_post_idx').on(table.nodeDomain, table.originalPostId),
  uniqueIndex('user_swarm_reposts_unique').on(table.userId, table.nodeDomain, table.originalPostId),
]);

// ============================================
// REMOTE REPOSTS (reposts from federated users on local posts)
// ============================================

export const remoteReposts = sqliteTable('remote_reposts', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  postId: text('post_id').notNull().references(() => posts.id, { onDelete: 'cascade' }),
  actorHandle: text('actor_handle').notNull(),
  actorDisplayName: text('actor_display_name'),
  actorAvatarUrl: text('actor_avatar_url'),
  actorIsNsfw: integer('actor_is_nsfw', { mode: 'boolean' }).default(false).notNull(),
  actorNodeDomain: text('actor_node_domain').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(currentTimestamp).notNull(),
}, (table) => [
  index('remote_reposts_post_idx').on(table.postId),
  index('remote_reposts_actor_idx').on(table.actorHandle, table.actorNodeDomain),
  uniqueIndex('remote_reposts_unique').on(table.postId, table.actorHandle, table.actorNodeDomain),
]);

// ============================================
// NOTIFICATIONS
// ============================================

export const notifications = sqliteTable('notifications', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  // Actor info - stored directly instead of referencing placeholder users
  actorId: text('actor_id').references(() => users.id, { onDelete: 'cascade' }), // Optional - only for local actors
  actorHandle: text('actor_handle').notNull(), // e.g., "user" or "user@remote.node"
  actorDisplayName: text('actor_display_name'),
  actorAvatarUrl: text('actor_avatar_url'),
  actorNodeDomain: text('actor_node_domain'), // null for local actors
  // Post reference
  postId: text('post_id').references(() => posts.id, { onDelete: 'cascade' }),
  remotePostId: text('remote_post_id'),
  remotePostDomain: text('remote_post_domain'),
  postContent: text('post_content'), // Cached content for display
  interactionId: text('interaction_id'), // Idempotency key for local and federated interactions
  type: text('type').notNull(), // follow | like | repost | mention
  readAt: integer('read_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(currentTimestamp).notNull(),
}, (table) => [
  index('notifications_user_idx').on(table.userId),
  index('notifications_created_idx').on(table.createdAt),
  uniqueIndex('notifications_interaction_unique_idx').on(table.interactionId),
]);


// ============================================
// MENTION DELIVERY OUTBOX
// ============================================

export const mentionDeliveries = sqliteTable('mention_deliveries', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  interactionId: text('interaction_id').notNull().unique(),
  postId: text('post_id').notNull().references(() => posts.id, { onDelete: 'cascade' }),
  targetHandle: text('target_handle').notNull(),
  targetDomain: text('target_domain').notNull(),
  status: text('status').default('pending').notNull(), // pending | processing | retry | delivered | dead
  attempts: integer('attempts').default(0).notNull(),
  nextAttemptAt: integer('next_attempt_at', { mode: 'timestamp' }).default(currentTimestamp).notNull(),
  lastAttemptAt: integer('last_attempt_at', { mode: 'timestamp' }),
  deliveredAt: integer('delivered_at', { mode: 'timestamp' }),
  lastError: text('last_error'),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(currentTimestamp).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).default(currentTimestamp).notNull(),
}, (table) => [
  uniqueIndex('mention_deliveries_target_unique_idx').on(table.postId, table.targetHandle, table.targetDomain),
  index('mention_deliveries_due_idx').on(table.status, table.nextAttemptAt),
]);


// ============================================
// HANDLE REGISTRY (for federated handle resolution)
// ============================================

export const handleRegistry = sqliteTable('handle_registry', {
  handle: text('handle').primaryKey(), // @username
  did: text('did').notNull(),
  nodeDomain: text('node_domain').notNull(),
  registeredAt: integer('registered_at', { mode: 'timestamp' }).default(currentTimestamp).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).default(currentTimestamp).notNull(),
}, (table) => [
  index('handle_registry_updated_idx').on(table.updatedAt),
]);

// ============================================
// SESSIONS (for auth)
// ============================================

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  token: text('token').notNull().unique(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(currentTimestamp).notNull(),
}, (table) => [
  index('sessions_token_idx').on(table.token),
  index('sessions_user_idx').on(table.userId),
]);


// ============================================
// BLOCKS & MUTES (user-level moderation)
// ============================================

export const blocks = sqliteTable('blocks', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  blockedUserId: text('blocked_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(currentTimestamp).notNull(),
}, (table) => [
  index('blocks_user_idx').on(table.userId),
  index('blocks_blocked_user_idx').on(table.blockedUserId),
]);


export const mutes = sqliteTable('mutes', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  mutedUserId: text('muted_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(currentTimestamp).notNull(),
}, (table) => [
  index('mutes_user_idx').on(table.userId),
  index('mutes_muted_user_idx').on(table.mutedUserId),
]);


// Muted nodes - hide all content from specific swarm nodes
export const mutedNodes = sqliteTable('muted_nodes', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  nodeDomain: text('node_domain').notNull(), // Domain of the muted node
  createdAt: integer('created_at', { mode: 'timestamp' }).default(currentTimestamp).notNull(),
}, (table) => [
  index('muted_nodes_user_idx').on(table.userId),
  index('muted_nodes_domain_idx').on(table.nodeDomain),
]);


// ============================================
// REPORTS (moderation)
// ============================================

export const reports = sqliteTable('reports', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  reporterId: text('reporter_id').references(() => users.id, { onDelete: 'set null' }),
  targetType: text('target_type').notNull(), // 'post' | 'user'
  targetId: text('target_id').notNull(),
  reason: text('reason').notNull(),
  status: text('status').default('open').notNull(), // open | resolved
  resolvedAt: integer('resolved_at', { mode: 'timestamp' }),
  resolvedBy: text('resolved_by').references(() => users.id),
  resolutionNote: text('resolution_note'),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(currentTimestamp).notNull(),
}, (table) => [
  index('reports_status_idx').on(table.status),
  index('reports_target_idx').on(table.targetType, table.targetId),
  index('reports_reporter_idx').on(table.reporterId),
]);



// ============================================
// SWARM - Node Discovery Network
// ============================================

/**
 * Discovered nodes in the swarm network.
 * Tracks all known Synapsis nodes discovered through gossip or seed nodes.
 */
export const swarmNodes = sqliteTable('swarm_nodes', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
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
  mediaCount: integer('media_count'),

  // NSFW flag (synced from remote node)
  isNsfw: integer('is_nsfw', { mode: 'boolean' }).default(false).notNull(),
  // Legacy discovery payloads omitted isNsfw. Keep that distinct from an
  // authoritative `false` so missing metadata can never be trusted as safe.
  nsfwClassificationKnown: integer('nsfw_classification_known', { mode: 'boolean' }).default(false).notNull(),

  // Discovery metadata
  discoveredVia: text('discovered_via'), // Domain of node that told us about this one
  discoveredAt: integer('discovered_at', { mode: 'timestamp' }).default(currentTimestamp).notNull(),

  // Health tracking
  lastSeenAt: integer('last_seen_at', { mode: 'timestamp' }).default(currentTimestamp).notNull(),
  lastSyncAt: integer('last_sync_at', { mode: 'timestamp' }),
  consecutiveFailures: integer('consecutive_failures').default(0).notNull(),
  isActive: integer('is_active', { mode: 'boolean' }).default(true).notNull(),

  // Trust/reputation (for future spam prevention)
  trustScore: integer('trust_score').default(50).notNull(), // 0-100

  // Admin moderation
  isBlocked: integer('is_blocked', { mode: 'boolean' }).default(false).notNull(),
  blockReason: text('block_reason'),
  blockedAt: integer('blocked_at', { mode: 'timestamp' }),

  // Capabilities
  capabilities: text('capabilities'), // JSON array: ["handles", "gossip", "relay"]

  createdAt: integer('created_at', { mode: 'timestamp' }).default(currentTimestamp).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).default(currentTimestamp).notNull(),
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
export const swarmSeeds = sqliteTable('swarm_seeds', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  domain: text('domain').notNull().unique(),

  // Priority for connection order (lower = higher priority)
  priority: integer('priority').default(100).notNull(),

  // Whether this seed is enabled
  isEnabled: integer('is_enabled', { mode: 'boolean' }).default(true).notNull(),

  // Health tracking
  lastContactAt: integer('last_contact_at', { mode: 'timestamp' }),
  consecutiveFailures: integer('consecutive_failures').default(0).notNull(),

  createdAt: integer('created_at', { mode: 'timestamp' }).default(currentTimestamp).notNull(),
}, (table) => [
  index('swarm_seeds_enabled_idx').on(table.isEnabled),
  index('swarm_seeds_priority_idx').on(table.priority),
]);

/**
 * Swarm sync log - tracks gossip exchanges between nodes.
 */
export const swarmSyncLog = sqliteTable('swarm_sync_log', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),

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
  success: integer('success', { mode: 'boolean' }).notNull(),
  errorMessage: text('error_message'),
  durationMs: integer('duration_ms'),

  createdAt: integer('created_at', { mode: 'timestamp' }).default(currentTimestamp).notNull(),
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
export const chatConversations = sqliteTable('chat_conversations', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),

  // Conversation type: 'direct' (1-on-1) or 'group' (future)
  type: text('type').default('direct').notNull(),

  // For direct chats, store both participants
  participant1Id: text('participant1_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  participant2Handle: text('participant2_handle').notNull(), // Can be local or remote (user@domain)

  // Last message info for sorting
  lastMessageAt: integer('last_message_at', { mode: 'timestamp' }),
  lastMessagePreview: text('last_message_preview'),

  // Existing conversations begin as legacy. The first encrypted message marks
  // the cutover without pretending older plaintext history was retroactively protected.
  encryptionMode: text('encryption_mode').default('legacy').notNull(),
  e2eeActivatedAt: integer('e2ee_activated_at', { mode: 'timestamp' }),

  // Metadata
  createdAt: integer('created_at', { mode: 'timestamp' }).default(currentTimestamp).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).default(currentTimestamp).notNull(),
}, (table) => [
  index('chat_conversations_participant1_idx').on(table.participant1Id),
  index('chat_conversations_last_message_idx').on(table.lastMessageAt),
  // Ensure unique conversation between two users
  uniqueIndex('chat_conversations_unique').on(table.participant1Id, table.participant2Handle),
]);


/**
 * Individual chat messages within conversations.
 * Legacy messages can contain plaintext. E2EE v1 messages store only a signed,
 * opaque encrypted envelope and leave `content` null.
 */
export const chatMessages = sqliteTable('chat_messages', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),

  // Which conversation this belongs to
  conversationId: text('conversation_id').notNull().references(() => chatConversations.id, { onDelete: 'cascade' }),

  // Sender info
  senderHandle: text('sender_handle').notNull(), // Can be local or remote
  senderDisplayName: text('sender_display_name'),
  senderAvatarUrl: text('sender_avatar_url'),
  senderNodeDomain: text('sender_node_domain'), // null if local
  senderDid: text('sender_did'), // DID for Signal Protocol

  // Message content (plain text for verified chat)
  content: text('content'),

  // End-to-end encrypted message fields. Protocol version 0 means legacy plaintext.
  protocolVersion: integer('protocol_version').default(0).notNull(),
  clientMessageId: text('client_message_id'),
  encryptedEnvelope: text('encrypted_envelope'),
  e2eeSignature: text('e2ee_signature'),
  e2eeActionNonce: text('e2ee_action_nonce'),
  e2eeActionTs: integer('e2ee_action_ts'),

  // Swarm sync info
  swarmMessageId: text('swarm_message_id').unique(), // Format: swarm:domain:uuid

  // Status tracking
  deliveredAt: integer('delivered_at', { mode: 'timestamp' }),
  readAt: integer('read_at', { mode: 'timestamp' }),

  // Metadata
  createdAt: integer('created_at', { mode: 'timestamp' }).default(currentTimestamp).notNull(),
}, (table) => [
  index('chat_messages_conversation_idx').on(table.conversationId),
  index('chat_messages_created_idx').on(table.createdAt),
  index('chat_messages_swarm_id_idx').on(table.swarmMessageId),
  uniqueIndex('chat_messages_conversation_client_id_unique').on(table.conversationId, table.clientMessageId),
]);




/**
 * Typing indicators for real-time chat UX.
 * Short-lived records that expire after 10 seconds.
 */
export const chatTypingIndicators = sqliteTable('chat_typing_indicators', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),

  conversationId: text('conversation_id').notNull().references(() => chatConversations.id, { onDelete: 'cascade' }),
  userHandle: text('user_handle').notNull(),

  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(currentTimestamp).notNull(),
}, (table) => [
  index('chat_typing_conversation_idx').on(table.conversationId),
  index('chat_typing_expires_idx').on(table.expiresAt),
  uniqueIndex('chat_typing_unique').on(table.conversationId, table.userHandle),
]);

// ============================================
// CRYPTO & SECURITY
// ============================================

/**
 * Current account encryption key, certified by the account's existing DID key.
 * Private material is never stored here.
 */
export const e2eeKeyBundles = sqliteTable('e2ee_key_bundles', {
  userId: text('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  did: text('did').notNull(),
  keyId: text('key_id').notNull(),
  keyVersion: integer('key_version').notNull(),
  publicKey: text('public_key').notNull(),
  proofAction: text('proof_action').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(currentTimestamp).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).default(currentTimestamp).notNull(),
}, (table) => [
  uniqueIndex('e2ee_key_bundles_did_unique').on(table.did),
  uniqueIndex('e2ee_key_bundles_key_id_unique').on(table.keyId),
]);

/**
 * Password recovery vault. The verifier is HMACed with a node secret and the
 * server share is separately encrypted, so a database-only leak is not an
 * offline password oracle. Legacy PIN vaults are marked for one-time migration.
 */
export const e2eeKeyVaults = sqliteTable('e2ee_key_vaults', {
  userId: text('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  keyId: text('key_id').notNull(),
  keyVersion: integer('key_version').notNull(),
  ownerDid: text('owner_did').notNull(),
  publicKey: text('public_key').notNull(),
  ciphertext: text('ciphertext').notNull(),
  nonce: text('nonce').notNull(),
  salt: text('salt').notNull(),
  kdfAlgorithm: text('kdf_algorithm').notNull(),
  kdfOpsLimit: integer('kdf_ops_limit').notNull(),
  kdfMemLimit: integer('kdf_mem_limit').notNull(),
  recoveryMethod: text('recovery_method').default('legacy_pin').notNull(),
  pinVerifierMac: text('pin_verifier_mac').notNull(),
  serverShareEncrypted: text('server_share_encrypted').notNull(),
  failedAttempts: integer('failed_attempts').default(0).notNull(),
  lockedUntil: integer('locked_until', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(currentTimestamp).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).default(currentTimestamp).notNull(),
}, (table) => [
  uniqueIndex('e2ee_key_vaults_key_id_unique').on(table.keyId),
]);

/**
 * Verified cache of remote users' DID-certified encryption keys. Key changes
 * must carry a fresh signature by the same account signing identity.
 */
export const e2eeRemoteKeyBundles = sqliteTable('e2ee_remote_key_bundles', {
  did: text('did').primaryKey(),
  handle: text('handle').notNull(),
  keyId: text('key_id').notNull(),
  keyVersion: integer('key_version').notNull(),
  publicKey: text('public_key').notNull(),
  proofAction: text('proof_action').notNull(),
  signingPublicKey: text('signing_public_key').notNull(),
  firstSeenAt: integer('first_seen_at', { mode: 'timestamp' }).default(currentTimestamp).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).default(currentTimestamp).notNull(),
}, (table) => [
  index('e2ee_remote_key_bundles_key_id_idx').on(table.keyId),
  index('e2ee_remote_key_bundles_handle_idx').on(table.handle),
]);

/**
 * Durable replay tombstones survive conversation deletion, preventing a valid
 * old signed envelope from recreating a message after the user removed it.
 */
export const e2eeMessageReceipts = sqliteTable('e2ee_message_receipts', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  ownerUserId: text('owner_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  senderDid: text('sender_did').notNull(),
  messageId: text('message_id').notNull(),
  protocolVersion: integer('protocol_version').default(1).notNull(),
  receivedAt: integer('received_at', { mode: 'timestamp' }).default(currentTimestamp).notNull(),
}, (table) => [
  uniqueIndex('e2ee_message_receipts_owner_sender_message_unique')
    .on(table.ownerUserId, table.senderDid, table.messageId),
  index('e2ee_message_receipts_received_idx').on(table.receivedAt),
]);

/**
 * Replay protection for signed user actions.
 * Enforces uniqueness of (did, nonce) within the valid timeframe.
 */
export const signedActionDedupe = sqliteTable('signed_action_dedupe', {
  // SHA-256 of canonical signed payload (without signature)
  actionId: text('action_id').primaryKey(),

  did: text('did').notNull(),
  nonce: text('nonce').notNull(),
  ts: integer('ts').notNull(),

  createdAt: integer('created_at', { mode: 'timestamp' }).default(currentTimestamp).notNull(),
}, (table) => [
  index('signed_action_dedupe_created_idx').on(table.createdAt), // For cleanup
]);

/**
 * Cache for remote public keys to enforce key continuity.
 * Prevents TOFU (Trust On First Use) attacks after initial trust.
 */
export const remoteIdentityCache = sqliteTable('remote_identity_cache', {
  did: text('did').primaryKey(), // The DID is the key
  publicKey: text('public_key').notNull(),

  fetchedAt: integer('fetched_at', { mode: 'timestamp' }).notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
});
