import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const mention = {
    id: '550e8400-e29b-41d4-a716-446655440000',
    botId: 'bot-id',
    postId: 'source-post-id',
    authorId: 'author-id',
    content: 'Hello @helperbot',
    isProcessed: false,
    processedAt: null as Date | null,
    responsePostId: null as string | null,
    isRemote: false,
    remoteActorUrl: null,
    createdAt: new Date('2026-07-15T20:00:00.000Z'),
  };
  return {
    mention,
    generateReply: vi.fn(),
    registerPostMentions: vi.fn(),
    recordReply: vi.fn(),
    deliverPost: vi.fn(),
    transaction: vi.fn(),
  };
});

const tables = vi.hoisted(() => ({
  botMentions: { id: 'botMentions.id', isProcessed: 'botMentions.isProcessed', responsePostId: 'botMentions.responsePostId', processedAt: 'botMentions.processedAt' },
  notifications: { id: 'notifications.id' },
  posts: { id: 'posts.id', repliesCount: 'posts.repliesCount' },
  users: { id: 'users.id', postsCount: 'users.postsCount' },
}));

vi.mock('drizzle-orm', () => ({
  and: (...values: unknown[]) => values,
  eq: (...values: unknown[]) => values,
  isNull: (value: unknown) => value,
  lte: (...values: unknown[]) => values,
  or: (...values: unknown[]) => values,
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
}));

vi.mock('@/db', () => {
  const sourcePost = {
    id: 'source-post-id',
    userId: 'author-id',
    content: 'Hello @helperbot',
    replyToId: null,
    createdAt: new Date('2026-07-15T20:00:00.000Z'),
    author: { handle: 'author', displayName: 'Author' },
  };
  const responsePost = {
    id: mocks.mention.id,
    userId: 'bot-user-id',
    content: 'A useful response',
    replyToId: sourcePost.id,
    createdAt: new Date('2026-07-15T20:01:00.000Z'),
    isNsfw: false,
  };
  const transactionClient = {
    insert: vi.fn((table: unknown) => ({
      values: vi.fn(() => table === tables.posts
        ? {
          onConflictDoNothing: () => ({ returning: vi.fn().mockResolvedValue([responsePost]) }),
        }
        : {
          onConflictDoNothing: vi.fn().mockResolvedValue([]),
        }),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((values: Record<string, unknown>) => ({
        where: vi.fn(async () => {
          if (table === tables.botMentions && typeof values.responsePostId === 'string') {
            mocks.mention.isProcessed = true;
            mocks.mention.processedAt = values.processedAt as Date;
            mocks.mention.responsePostId = values.responsePostId;
          }
        }),
      })),
    })),
    select: vi.fn(() => ({
      from: () => ({ where: () => ({ limit: vi.fn().mockResolvedValue([]) }) }),
    })),
  };
  const db = {
    query: {
      botMentions: {
        findFirst: vi.fn(async () => ({ ...mocks.mention })),
      },
      bots: {
        findFirst: vi.fn(async () => ({
          id: 'bot-id',
          name: 'Helper',
          personalityConfig: JSON.stringify({ systemPrompt: 'Be useful', temperature: 0.5, maxTokens: 200 }),
          llmProvider: 'openai',
          llmModel: 'gpt-4o-mini',
          llmEndpoint: null,
          llmApiKeyEncrypted: 'encrypted',
          user: {
            id: 'bot-user-id',
            handle: 'helperbot',
            displayName: 'Helper Bot',
            avatarUrl: null,
            isNsfw: false,
            did: 'did:synapsis:helperbot',
            publicKey: 'public-key',
          },
        })),
      },
      posts: {
        findFirst: vi.fn(async () => sourcePost),
      },
    },
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => ({
        where: vi.fn(() => {
          let claimed = false;
          if (values.isProcessed === true && mocks.mention.isProcessed === false) {
            claimed = true;
            mocks.mention.isProcessed = true;
            mocks.mention.processedAt = values.processedAt as Date;
          } else if (values.isProcessed === false) {
            mocks.mention.isProcessed = false;
            mocks.mention.processedAt = null;
          }
          return {
            returning: vi.fn().mockResolvedValue(claimed ? [{ id: mocks.mention.id }] : []),
            then: (resolve: (value: unknown) => unknown) => Promise.resolve(undefined).then(resolve),
            catch: (reject: (reason: unknown) => unknown) => Promise.resolve(undefined).catch(reject),
          };
        }),
      })),
    })),
    transaction: mocks.transaction.mockImplementation(async (callback: (tx: typeof transactionClient) => Promise<unknown>) => callback(transactionClient)),
  };
  return { db, ...tables };
});

vi.mock('./contentGenerator', () => ({
  ContentGenerator: class ContentGenerator {
    generateReply = mocks.generateReply;
  },
}));

vi.mock('./rateLimiter', () => ({
  canReply: vi.fn().mockResolvedValue({ allowed: true }),
  recordReply: mocks.recordReply,
}));

vi.mock('@/lib/mentions/delivery', () => ({
  registerPostMentions: mocks.registerPostMentions,
}));

vi.mock('@/lib/swarm/interactions', () => ({
  deliverPostToSwarmFollowers: mocks.deliverPost,
}));

import { processMention } from './mentionHandler';

describe('bot mention processing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mention.isProcessed = false;
    mocks.mention.processedAt = null;
    mocks.mention.responsePostId = null;
    mocks.generateReply.mockResolvedValue({ text: 'A useful response', tokensUsed: 12, model: 'test' });
    mocks.registerPostMentions.mockResolvedValue({ localNotifications: 0, remoteQueued: 0, skipped: 0 });
    mocks.recordReply.mockResolvedValue(undefined);
    mocks.deliverPost.mockResolvedValue({ delivered: 0, failed: 0 });
  });

  it('persists one deterministic reply and returns it on a repeated request', async () => {
    const first = await processMention(mocks.mention.id);
    const second = await processMention(mocks.mention.id);

    expect(first).toEqual({ success: true, responsePostId: mocks.mention.id });
    expect(second).toEqual(first);
    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.generateReply).toHaveBeenCalledOnce();
    expect(mocks.registerPostMentions).toHaveBeenCalledOnce();
  });

  it('rejects a concurrent processor while the first owns the lease', async () => {
    let finishGeneration!: (value: { text: string; tokensUsed: number; model: string }) => void;
    mocks.generateReply.mockReturnValue(new Promise((resolve) => {
      finishGeneration = resolve;
    }));

    const firstRequest = processMention(mocks.mention.id);
    await vi.waitFor(() => expect(mocks.generateReply).toHaveBeenCalledOnce());

    await expect(processMention(mocks.mention.id)).resolves.toEqual({
      success: false,
      error: 'Mention is already being processed',
    });

    finishGeneration({ text: 'A useful response', tokensUsed: 12, model: 'test' });
    await expect(firstRequest).resolves.toEqual({
      success: true,
      responsePostId: mocks.mention.id,
    });
    expect(mocks.transaction).toHaveBeenCalledOnce();
  });
});
