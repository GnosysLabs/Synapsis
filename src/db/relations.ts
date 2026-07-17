import { defineRelations } from 'drizzle-orm';
import * as schema from './schema';

export const relations = defineRelations(schema, (r) => ({
  users: {
    node: r.one.nodes({ from: r.users.nodeId, to: r.nodes.id }),
    posts: r.many.posts({ from: r.users.id, to: r.posts.userId }),
    stuffboxConnection: r.one.stuffboxConnections({
      from: r.users.id,
      to: r.stuffboxConnections.userId,
    }),
    cliCredentials: r.many.cliCredentials({
      from: r.users.id,
      to: r.cliCredentials.userId,
    }),
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
    mentionDeliveries: r.many.mentionDeliveries({ from: r.posts.id, to: r.mentionDeliveries.postId }),
  },
  media: {
    user: r.one.users({ from: r.media.userId, to: r.users.id, optional: false }),
    post: r.one.posts({ from: r.media.postId, to: r.posts.id }),
  },
  stuffboxConnections: {
    user: r.one.users({
      from: r.stuffboxConnections.userId,
      to: r.users.id,
      optional: false,
    }),
  },
  cliCredentials: {
    user: r.one.users({
      from: r.cliCredentials.userId,
      to: r.users.id,
      optional: false,
    }),
    authorizationRequests: r.many.cliAuthorizationRequests({
      from: r.cliCredentials.id,
      to: r.cliAuthorizationRequests.credentialId,
    }),
  },
  cliAuthorizationRequests: {
    credential: r.one.cliCredentials({
      from: r.cliAuthorizationRequests.credentialId,
      to: r.cliCredentials.id,
    }),
    approvedBy: r.one.users({
      from: r.cliAuthorizationRequests.approvedByUserId,
      to: r.users.id,
    }),
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
  mentionDeliveries: {
    post: r.one.posts({
      from: r.mentionDeliveries.postId,
      to: r.posts.id,
      optional: false,
    }),
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
