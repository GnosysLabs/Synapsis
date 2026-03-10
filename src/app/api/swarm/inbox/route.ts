/**
 * Swarm Inbox Endpoint
 * 
 * POST: Receive posts from users on other swarm nodes that local users follow
 * 
 * When a user on another Synapsis node creates a post, it gets pushed here
 * for their followers on this node.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, posts, users, media, remoteFollowers } from '@/db';
import { eq, and } from 'drizzle-orm';
import { z } from 'zod';

const swarmPostSchema = z.object({
  post: z.object({
    id: z.string(),
    content: z.string(),
    createdAt: z.string(),
    isNsfw: z.boolean(),
    replyToId: z.string().optional(),
    repostOfId: z.string().optional(),
    media: z.array(z.object({
      url: z.string(),
      mimeType: z.string().optional(),
      altText: z.string().optional(),
    })).optional(),
    linkPreviewUrl: z.string().optional(),
    linkPreviewTitle: z.string().optional(),
    linkPreviewDescription: z.string().optional(),
    linkPreviewImage: z.string().optional(),
    linkPreviewType: z.enum(['card', 'image', 'gallery', 'video']).optional(),
    linkPreviewVideoUrl: z.string().optional(),
    linkPreviewMedia: z.array(z.object({
      url: z.string(),
      width: z.number().nullable().optional(),
      height: z.number().nullable().optional(),
      mimeType: z.string().nullable().optional(),
    })).optional(),
  }),
  author: z.object({
    handle: z.string(),
    displayName: z.string(),
    avatarUrl: z.string().optional(),
    isNsfw: z.boolean(),
  }),
  nodeDomain: z.string(),
  timestamp: z.string(),
});

/**
 * POST /api/swarm/inbox
 * 
 * DEPRECATED: This endpoint is disabled.
 * We now use real-time pull-based federation via /api/swarm/timeline
 * instead of push-based caching.
 */
export async function POST(request: NextRequest) {
  return NextResponse.json({
    error: 'This endpoint is deprecated. Swarm uses real-time pull-based federation.',
  }, { status: 410 }); // 410 Gone
}
