/**
 * Signed Fetch - Client-side API wrapper
 * 
 * Automatically signs all user actions with their private key before
 * sending to the server. This ensures cryptographic proof of authenticity.
 */

import { createSignedAction, hasUserPrivateKey } from '@/lib/crypto/user-signing';
import type { E2EEMessageEnvelope } from '@/lib/e2ee/protocol';

export interface SignedFetchOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

/**
 * Make a signed API request
 * 
 * @param url - The API endpoint
 * @param action - The action being performed (e.g., 'like', 'follow', 'post')
 * @param data - The action data
 * @param userDid - The user's DID
 * @param userHandle - The user's handle
 * @param options - Additional fetch options
 */
export async function signedFetch(
  url: string,
  action: string,
  data: unknown,
  userDid: string,
  userHandle: string,
  options: SignedFetchOptions = {}
): Promise<Response> {
  // Check if user has their private key loaded
  if (!hasUserPrivateKey()) {
    throw new Error('User identity not unlocked. Please log in again.');
  }

  // Create signed action
  // Note: createSignedAction now generates nonce and ts internally
  const signedAction = await createSignedAction(action, data, userDid, userHandle);

  // Make the request
  return fetch(url, {
    method: options.method || 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
    body: JSON.stringify(signedAction),
  });
}

/**
 * Helper for common actions
 */
export const signedAPI = {
  /**
   * Like a post
   */
  async likePost(postId: string, userDid: string, userHandle: string) {
    return signedFetch(
      `/api/posts/${postId}/like`,
      'like',
      { postId },
      userDid,
      userHandle
    );
  },

  /**
   * Unlike a post
   */
  async unlikePost(postId: string, userDid: string, userHandle: string) {
    return signedFetch(
      `/api/posts/${postId}/like`,
      'unlike',
      { postId },
      userDid,
      userHandle,
      { method: 'DELETE' }
    );
  },

  /**
   * Follow a user
   */
  async followUser(targetHandle: string, userDid: string, userHandle: string) {
    return signedFetch(
      `/api/users/${targetHandle}/follow`,
      'follow',
      { targetHandle },
      userDid,
      userHandle
    );
  },

  /**
   * Unfollow a user
   */
  async unfollowUser(targetHandle: string, userDid: string, userHandle: string) {
    return signedFetch(
      `/api/users/${targetHandle}/follow`,
      'unfollow',
      { targetHandle },
      userDid,
      userHandle,
      { method: 'DELETE' }
    );
  },

  /**
   * Create a post
   */
  async createPost(
    content: string,
    mediaIds: string[],
    linkPreview: unknown,
    replyToId: string | undefined,
    swarmReplyTo: unknown | undefined,
    isNsfw: boolean,
    userDid: string,
    userHandle: string
  ) {
    return signedFetch(
      '/api/posts',
      'post',
      { content, mediaIds, linkPreview, replyToId, swarmReplyTo, isNsfw },
      userDid,
      userHandle
    );
  },

  /**
   * Repost a post
   */
  async repostPost(postId: string, userDid: string, userHandle: string) {
    return signedFetch(
      `/api/posts/${postId}/repost`,
      'repost',
      { postId },
      userDid,
      userHandle
    );
  },

  /**
   * Unrepost a post
   */
  async unrepostPost(postId: string, userDid: string, userHandle: string) {
    return signedFetch(
      `/api/posts/${postId}/repost`,
      'unrepost',
      { postId },
      userDid,
      userHandle,
      { method: 'DELETE' }
    );
  },

  /**
   * Delete a post
   */
  async deletePost(postId: string, userDid: string, userHandle: string) {
    return signedFetch(
      `/api/posts/${postId}`,
      'delete',
      { postId },
      userDid,
      userHandle,
      { method: 'DELETE' }
    );
  },

  /**
   * Submit a report
   */
  async report(targetType: string, targetId: string, reason: string, userDid: string, userHandle: string) {
    return signedFetch(
      '/api/reports',
      'report',
      { targetType, targetId, reason },
      userDid,
      userHandle
    );
  },

  /**
   * Block a user
   */
  async blockUser(handle: string, userDid: string, userHandle: string) {
    return signedFetch(
      `/api/users/${handle}/block`,
      'block',
      { handle },
      userDid,
      userHandle
    );
  },

  /**
   * Mute a node
   */
  async muteNode(domain: string, userDid: string, userHandle: string) {
    return signedFetch(
      '/api/settings/muted-nodes',
      'mute_node',
      { domain },
      userDid,
      userHandle
    );
  },
  /**
   * Send a chat message
   */
  async sendChat(envelope: E2EEMessageEnvelope, userDid: string, userHandle: string) {
    return signedFetch(
      '/api/chat/send',
      'chat_e2ee',
      envelope,
      userDid,
      userHandle
    );
  },
};
