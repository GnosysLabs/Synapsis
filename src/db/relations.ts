import { defineRelations } from 'drizzle-orm';
import * as schema from './schema';

export const relations = defineRelations(schema, (r) => ({
  users: {
    node: r.one.nodes({ from: r.users.nodeId, to: r.nodes.id }),
    botOwner: r.one.users({
      from: r.users.botOwnerId,
      to: r.users.id,
      alias: 'ownedBots',
    }),
    ownedBotUsers: r.many.users({
      from: r.users.id,
      to: r.users.botOwnerId,
      alias: 'ownedBots',
    }),
    posts: r.many.posts({ from: r.users.id, to: r.posts.userId }),
    followersRelation: r.many.follows({
      from: r.users.id,
      to: r.follows.followingId,
      alias: 'following',
    }),
    followingRelation: r.many.follows({
      from: r.users.id,
      to: r.follows.followerId,
      alias: 'follower',
    }),
  },
  posts: {
    author: r.one.users({ from: r.posts.userId, to: r.users.id, optional: false }),
    bot: r.one.bots({ from: r.posts.botId, to: r.bots.id }),
    removedByUser: r.one.users({ from: r.posts.removedBy, to: r.users.id }),
    replyTo: r.one.posts({
      from: r.posts.replyToId,
      to: r.posts.id,
      alias: 'replies',
    }),
    replies: r.many.posts({
      from: r.posts.id,
      to: r.posts.replyToId,
      alias: 'replies',
    }),
    repostOf: r.one.posts({
      from: r.posts.repostOfId,
      to: r.posts.id,
      alias: 'reposts',
    }),
    reposts: r.many.posts({
      from: r.posts.id,
      to: r.posts.repostOfId,
      alias: 'reposts',
    }),
    likes: r.many.likes({ from: r.posts.id, to: r.likes.postId }),
    media: r.many.media({ from: r.posts.id, to: r.media.postId }),
  },
  media: {
    user: r.one.users({ from: r.media.userId, to: r.users.id, optional: false }),
    post: r.one.posts({ from: r.media.postId, to: r.posts.id }),
  },
  follows: {
    follower: r.one.users({
      from: r.follows.followerId,
      to: r.users.id,
      alias: 'follower',
      optional: false,
    }),
    following: r.one.users({
      from: r.follows.followingId,
      to: r.users.id,
      alias: 'following',
      optional: false,
    }),
  },
  likes: {
    user: r.one.users({ from: r.likes.userId, to: r.users.id, optional: false }),
    post: r.one.posts({ from: r.likes.postId, to: r.posts.id, optional: false }),
  },
  notifications: {
    recipient: r.one.users({
      from: r.notifications.userId,
      to: r.users.id,
      alias: 'recipient',
      optional: false,
    }),
    actor: r.one.users({
      from: r.notifications.actorId,
      to: r.users.id,
      alias: 'actor',
      optional: false,
    }),
    post: r.one.posts({ from: r.notifications.postId, to: r.posts.id }),
  },
  sessions: {
    user: r.one.users({ from: r.sessions.userId, to: r.users.id, optional: false }),
  },
  blocks: {
    user: r.one.users({ from: r.blocks.userId, to: r.users.id, optional: false }),
    blockedUser: r.one.users({ from: r.blocks.blockedUserId, to: r.users.id, optional: false }),
  },
  mutes: {
    user: r.one.users({ from: r.mutes.userId, to: r.users.id, optional: false }),
    mutedUser: r.one.users({ from: r.mutes.mutedUserId, to: r.users.id, optional: false }),
  },
  mutedNodes: {
    user: r.one.users({ from: r.mutedNodes.userId, to: r.users.id, optional: false }),
  },
  reports: {
    reporter: r.one.users({ from: r.reports.reporterId, to: r.users.id }),
    resolver: r.one.users({ from: r.reports.resolvedBy, to: r.users.id }),
  },
  bots: {
    user: r.one.users({
      from: r.bots.userId,
      to: r.users.id,
      alias: 'botUser',
      optional: false,
    }),
    owner: r.one.users({
      from: r.bots.ownerId,
      to: r.users.id,
      alias: 'botOwner',
      optional: false,
    }),
    contentSources: r.many.botContentSources({ from: r.bots.id, to: r.botContentSources.botId }),
    mentions: r.many.botMentions({ from: r.bots.id, to: r.botMentions.botId }),
    activityLogs: r.many.botActivityLogs({ from: r.bots.id, to: r.botActivityLogs.botId }),
    rateLimits: r.many.botRateLimits({ from: r.bots.id, to: r.botRateLimits.botId }),
  },
  botContentSources: {
    bot: r.one.bots({ from: r.botContentSources.botId, to: r.bots.id, optional: false }),
    contentItems: r.many.botContentItems({
      from: r.botContentSources.id,
      to: r.botContentItems.sourceId,
    }),
  },
  botContentItems: {
    source: r.one.botContentSources({
      from: r.botContentItems.sourceId,
      to: r.botContentSources.id,
      optional: false,
    }),
    post: r.one.posts({ from: r.botContentItems.postId, to: r.posts.id }),
  },
  botMentions: {
    bot: r.one.bots({ from: r.botMentions.botId, to: r.bots.id, optional: false }),
    post: r.one.posts({ from: r.botMentions.postId, to: r.posts.id, optional: false }),
    author: r.one.users({ from: r.botMentions.authorId, to: r.users.id, optional: false }),
    responsePost: r.one.posts({
      from: r.botMentions.responsePostId,
      to: r.posts.id,
    }),
  },
  botActivityLogs: {
    bot: r.one.bots({ from: r.botActivityLogs.botId, to: r.bots.id, optional: false }),
  },
  botRateLimits: {
    bot: r.one.bots({ from: r.botRateLimits.botId, to: r.bots.id, optional: false }),
  },
  chatConversations: {
    participant1: r.one.users({
      from: r.chatConversations.participant1Id,
      to: r.users.id,
      optional: false,
    }),
    messages: r.many.chatMessages({
      from: r.chatConversations.id,
      to: r.chatMessages.conversationId,
    }),
  },
  chatMessages: {
    conversation: r.one.chatConversations({
      from: r.chatMessages.conversationId,
      to: r.chatConversations.id,
      optional: false,
    }),
  },
}));
