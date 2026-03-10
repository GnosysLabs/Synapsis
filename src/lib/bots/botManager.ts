/**
 * Bot Manager Service
 * 
 * Core orchestrator for bot lifecycle, configuration, and operations.
 * Handles bot CRUD operations, user linking, and cryptographic key generation.
 * 
 * Bots are first-class users with their own profiles, handles, and posts.
 * Each bot has an owner (human user) who manages it.
 * 
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6
 */

import { db, bots, users, botContentSources, botContentItems, botMentions, botActivityLogs, botRateLimits, follows } from '@/db';
import { generateAndUploadAvatarToUserStorage } from '@/lib/storage/s3';
import { decryptPrivateKey, deserializeEncryptedKey } from '@/lib/crypto/private-key';
import { eq, and, count } from 'drizzle-orm';
import { generateKeyPair } from '@/lib/crypto/keys';
import { isIP } from 'net';
import { 
  encryptApiKey, 
  decryptApiKey,
  serializeEncryptedData, 
  deserializeEncryptedData,
  validateApiKeyFormat, 
  type LLMProvider 
} from './encryption';

// ============================================
// TYPES
// ============================================

export interface PersonalityConfig {
  systemPrompt: string;
  temperature: number;
  maxTokens: number;
  responseStyle?: string;
}

export interface ScheduleConfig {
  type: 'interval' | 'times' | 'cron';
  intervalMinutes?: number;
  times?: string[]; // HH:MM format
  cronExpression?: string;
  timezone?: string;
}

export interface BotCreateInput {
  name: string;
  handle: string;
  bio?: string;
  avatarUrl?: string;
  headerUrl?: string;
  personality: PersonalityConfig;
  llmProvider: LLMProvider;
  llmModel: string;
  llmEndpoint?: string;
  llmApiKey: string;
  schedule?: ScheduleConfig;
  autonomousMode?: boolean;
}

export interface BotUpdateInput {
  name?: string;
  bio?: string;
  avatarUrl?: string;
  headerUrl?: string;
  personality?: PersonalityConfig;
  llmProvider?: LLMProvider;
  llmModel?: string;
  llmEndpoint?: string | null;
  llmApiKey?: string;
  schedule?: ScheduleConfig | null;
  autonomousMode?: boolean;
  isActive?: boolean;
}

export interface Bot {
  id: string;
  userId: string; // The bot's own user account
  ownerId: string; // The human who manages this bot
  name: string;
  handle: string;
  bio: string | null;
  avatarUrl: string | null;
  headerUrl: string | null;
  personalityConfig: PersonalityConfig;
  llmProvider: LLMProvider;
  llmModel: string;
  llmEndpoint?: string | null;
  scheduleConfig: ScheduleConfig | null;
  autonomousMode: boolean;
  isActive: boolean;
  isSuspended: boolean;
  suspensionReason: string | null;
  suspendedAt: Date | null;
  publicKey: string;
  lastPostAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

// ============================================
// CONSTANTS
// ============================================

/**
 * Default maximum number of bots per user.
 * Can be overridden via BOT_MAX_PER_USER environment variable.
 */
const DEFAULT_MAX_BOTS_PER_USER = 5;

/**
 * Get the maximum bots per user from environment or default.
 */
export function getMaxBotsPerUser(): number {
  const envValue = process.env.BOT_MAX_PER_USER;
  if (envValue) {
    const parsed = parseInt(envValue, 10);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_MAX_BOTS_PER_USER;
}

// ============================================
// ERROR CLASSES
// ============================================

export class BotError extends Error {
  constructor(message: string, public code: string) {
    super(message);
    this.name = 'BotError';
  }
}

export class BotNotFoundError extends BotError {
  constructor(botId: string) {
    super(`Bot not found: ${botId}`, 'BOT_NOT_FOUND');
  }
}

export class BotLimitExceededError extends BotError {
  constructor(userId: string, limit: number) {
    super(`User ${userId} has reached the maximum bot limit of ${limit}`, 'BOT_LIMIT_EXCEEDED');
  }
}

export class BotHandleTakenError extends BotError {
  constructor(handle: string) {
    super(`Bot handle is already taken: ${handle}`, 'BOT_HANDLE_TAKEN');
  }
}

export class BotValidationError extends BotError {
  constructor(message: string) {
    super(message, 'BOT_VALIDATION_ERROR');
  }
}

// ============================================
// VALIDATION FUNCTIONS
// ============================================

/**
 * Validate bot handle format.
 * Handles must be 3-30 characters, alphanumeric and underscores only.
 */
export function validateBotHandle(handle: string): void {
  if (!handle || typeof handle !== 'string') {
    throw new BotValidationError('Bot handle is required');
  }
  
  if (!/^[a-zA-Z0-9_]{3,30}$/.test(handle)) {
    throw new BotValidationError('Bot handle must be 3-30 characters, alphanumeric and underscores only');
  }
}

/**
 * Validate bot name.
 */
export function validateBotName(name: string): void {
  if (!name || typeof name !== 'string') {
    throw new BotValidationError('Bot name is required');
  }
  
  if (name.length < 1 || name.length > 100) {
    throw new BotValidationError('Bot name must be 1-100 characters');
  }
}

/**
 * Validate personality configuration.
 */
export function validatePersonalityConfig(config: PersonalityConfig): void {
  if (!config || typeof config !== 'object') {
    throw new BotValidationError('Personality configuration is required');
  }
  
  if (!config.systemPrompt || typeof config.systemPrompt !== 'string') {
    throw new BotValidationError('System prompt is required');
  }
  
  if (config.systemPrompt.length > 10000) {
    throw new BotValidationError('System prompt must be 10000 characters or less');
  }
  
  if (typeof config.temperature !== 'number' || config.temperature < 0 || config.temperature > 2) {
    throw new BotValidationError('Temperature must be a number between 0 and 2');
  }
  
  if (typeof config.maxTokens !== 'number' || config.maxTokens < 1 || config.maxTokens > 100000) {
    throw new BotValidationError('Max tokens must be a number between 1 and 100000');
  }
}

/**
 * Validate schedule configuration.
 */
export function validateScheduleConfig(config: ScheduleConfig): void {
  if (!config || typeof config !== 'object') {
    throw new BotValidationError('Schedule configuration is required');
  }
  
  if (!['interval', 'times', 'cron'].includes(config.type)) {
    throw new BotValidationError('Schedule type must be interval, times, or cron');
  }
  
  if (config.type === 'interval') {
    if (typeof config.intervalMinutes !== 'number' || config.intervalMinutes < 5) {
      throw new BotValidationError('Interval must be at least 5 minutes');
    }
  }
  
  if (config.type === 'times') {
    if (!Array.isArray(config.times) || config.times.length === 0) {
      throw new BotValidationError('Times array is required for times schedule type');
    }
    
    const timePattern = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
    for (const time of config.times) {
      if (!timePattern.test(time)) {
        throw new BotValidationError(`Invalid time format: ${time}. Use HH:MM format`);
      }
    }
  }
  
  if (config.type === 'cron') {
    if (!config.cronExpression || typeof config.cronExpression !== 'string') {
      throw new BotValidationError('Cron expression is required for cron schedule type');
    }
  }
}

function isPrivateHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();

  if (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.local')
  ) {
    return true;
  }

  const ipVersion = isIP(normalized);
  if (ipVersion === 4) {
    const octets = normalized.split('.').map(Number);
    const [first, second] = octets;

    return (
      first === 10 ||
      first === 127 ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168)
    );
  }

  if (ipVersion === 6) {
    return normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80:');
  }

  return false;
}

export function normalizeAndValidateLlmEndpoint(endpoint: string): string {
  if (!endpoint || typeof endpoint !== 'string') {
    throw new BotValidationError('Custom endpoint is required');
  }

  let parsed: URL;
  try {
    parsed = new URL(endpoint.trim());
  } catch {
    throw new BotValidationError('Custom endpoint must be a valid URL');
  }

  if (parsed.protocol !== 'https:') {
    throw new BotValidationError('Custom endpoint must use HTTPS');
  }

  if (parsed.username || parsed.password) {
    throw new BotValidationError('Custom endpoint cannot include embedded credentials');
  }

  if (isPrivateHostname(parsed.hostname)) {
    throw new BotValidationError('Custom endpoint must be publicly reachable and cannot target localhost or a private network');
  }

  return parsed.toString();
}

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Convert database bot row to Bot interface.
 * Requires the bot's user account to be loaded.
 */
function dbBotToBot(dbBot: typeof bots.$inferSelect, botUser: typeof users.$inferSelect): Bot {
  return {
    id: dbBot.id,
    userId: dbBot.userId,
    ownerId: dbBot.ownerId,
    name: dbBot.name,
    handle: botUser.handle,
    bio: botUser.bio,
    avatarUrl: botUser.avatarUrl,
    headerUrl: botUser.headerUrl,
    personalityConfig: JSON.parse(dbBot.personalityConfig) as PersonalityConfig,
    llmProvider: dbBot.llmProvider as LLMProvider,
    llmModel: dbBot.llmModel,
    llmEndpoint: dbBot.llmEndpoint,
    scheduleConfig: dbBot.scheduleConfig ? JSON.parse(dbBot.scheduleConfig) as ScheduleConfig : null,
    autonomousMode: dbBot.autonomousMode,
    isActive: dbBot.isActive,
    isSuspended: dbBot.isSuspended,
    suspensionReason: dbBot.suspensionReason,
    suspendedAt: dbBot.suspendedAt,
    publicKey: botUser.publicKey,
    lastPostAt: dbBot.lastPostAt,
    createdAt: dbBot.createdAt,
    updatedAt: dbBot.updatedAt,
  };
}

// ============================================
// BOT MANAGER FUNCTIONS
// ============================================

/**
 * Create a new bot for a user.
 * Creates a user account for the bot with isBot=true.
 * 
 * @param ownerId - The ID of the user creating/owning the bot
 * @param config - Bot configuration
 * @returns The created bot
 * @throws BotLimitExceededError if user has reached max bots
 * @throws BotHandleTakenError if handle is already taken
 * @throws BotValidationError if configuration is invalid
 * 
 * Validates: Requirements 1.1, 1.2, 1.6
 */
export async function createBot(ownerId: string, config: BotCreateInput): Promise<Bot> {
  // Validate inputs
  validateBotHandle(config.handle);
  validateBotName(config.name);
  validatePersonalityConfig(config.personality);
  
  if (config.schedule) {
    validateScheduleConfig(config.schedule);
  }

  const normalizedEndpoint = config.llmProvider === 'custom'
    ? normalizeAndValidateLlmEndpoint(config.llmEndpoint || '')
    : null;
  
  // Validate API key format
  const apiKeyValidation = validateApiKeyFormat(config.llmApiKey, config.llmProvider);
  if (!apiKeyValidation.valid) {
    throw new BotValidationError(apiKeyValidation.error || 'Invalid API key');
  }
  
  // Check bot limit for user
  const maxBots = getMaxBotsPerUser();
  const [botCountResult] = await db
    .select({ count: count() })
    .from(bots)
    .where(eq(bots.ownerId, ownerId));
  
  if (botCountResult.count >= maxBots) {
    throw new BotLimitExceededError(ownerId, maxBots);
  }
  
  // Check if handle is taken (in users table now)
  const existingUser = await db.query.users.findFirst({
    where: eq(users.handle, config.handle.toLowerCase()),
  });
  
  if (existingUser) {
    throw new BotHandleTakenError(config.handle);
  }
  
  // Get owner to access their S3 storage for bot avatar
  const owner = await db.query.users.findFirst({
    where: eq(users.id, ownerId),
  });
  
  if (!owner) {
    throw new BotValidationError('Owner user not found');
  }
  
  // Generate cryptographic keys for the bot's user account
  const { publicKey, privateKey } = await generateKeyPair();
  
  // Encrypt the API key and private key
  const encryptedApiKey = encryptApiKey(config.llmApiKey);
  const encryptedPrivateKey = encryptApiKey(privateKey);
  
  // Generate a DID for the bot
  const nodeDomain = process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:3000';
  const botDid = `did:web:${nodeDomain}:users:${config.handle.toLowerCase()}`;
  
  // Generate bot avatar using owner's S3 storage if no avatar provided
  let botAvatarUrl = config.avatarUrl || null;
  if (!botAvatarUrl && owner.storageAccessKeyEncrypted && owner.storageSecretKeyEncrypted && owner.storageBucket) {
    try {
      // We need the owner's password to decrypt S3 credentials
      // Since we don't have the password here, we'll leave avatar null
      // The frontend should handle avatar generation with the user's password
      // Or we can generate a default avatar URL pattern
      console.log('[BotManager] Bot avatar will need to be set via API with user password');
    } catch (err) {
      console.error('[BotManager] Failed to generate bot avatar:', err);
    }
  }
  
  // Create the bot's user account first
  const [botUser] = await db.insert(users).values({
    did: botDid,
    handle: config.handle.toLowerCase(),
    displayName: config.name,
    bio: config.bio || null,
    avatarUrl: botAvatarUrl,
    headerUrl: config.headerUrl || null,
    publicKey,
    privateKeyEncrypted: serializeEncryptedData(encryptedPrivateKey),
    isBot: true,
    botOwnerId: ownerId,
  }).returning();
  
  // Create the bot configuration
  const [createdBot] = await db.insert(bots).values({
    userId: botUser.id, // The bot's own user account
    ownerId, // The human who manages this bot
    name: config.name,
    personalityConfig: JSON.stringify(config.personality),
    llmProvider: config.llmProvider,
    llmModel: config.llmModel,
    llmEndpoint: normalizedEndpoint,
    llmApiKeyEncrypted: serializeEncryptedData(encryptedApiKey),
    scheduleConfig: config.schedule ? JSON.stringify(config.schedule) : null,
    autonomousMode: config.autonomousMode ?? false,
    isActive: true,
    isSuspended: false,
  }).returning();
  
  // Auto-follow the bot so its posts appear in the owner's home feed
  await db.insert(follows).values({
    followerId: ownerId,
    followingId: botUser.id,
  });
  
  // Update follower/following counts
  await db.update(users)
    .set({ followersCount: 1 })
    .where(eq(users.id, botUser.id));
  
  if (owner) {
    await db.update(users)
      .set({ followingCount: owner.followingCount + 1 })
      .where(eq(users.id, ownerId));
  }
  
  return dbBotToBot(createdBot, botUser);
}

/**
 * Update an existing bot's configuration.
 * Updates both the bot config and the bot's user account.
 * 
 * @param botId - The ID of the bot to update
 * @param config - Updated configuration
 * @returns The updated bot
 * @throws BotNotFoundError if bot doesn't exist
 * @throws BotValidationError if configuration is invalid
 * 
 * Validates: Requirements 1.1
 */
export async function updateBot(botId: string, config: BotUpdateInput): Promise<Bot> {
  // Validate inputs if provided
  if (config.name !== undefined) {
    validateBotName(config.name);
  }
  
  if (config.personality !== undefined) {
    validatePersonalityConfig(config.personality);
  }
  
  if (config.schedule !== undefined && config.schedule !== null) {
    validateScheduleConfig(config.schedule);
  }

  // Check if bot exists and get its user account
  const existingBot = await db.query.bots.findFirst({
    where: eq(bots.id, botId),
  });
  
  if (!existingBot) {
    throw new BotNotFoundError(botId);
  }
  
  // Get the bot's user account
  const botUser = await db.query.users.findFirst({
    where: eq(users.id, existingBot.userId),
  });
  
  if (!botUser) {
    throw new BotNotFoundError(botId);
  }

  const targetProvider = (config.llmProvider ?? existingBot.llmProvider) as LLMProvider;

  if (targetProvider === 'custom') {
    const endpointToValidate = config.llmEndpoint !== undefined ? config.llmEndpoint : existingBot.llmEndpoint;
    if (!endpointToValidate) {
      throw new BotValidationError('Custom endpoint is required');
    }
    config.llmEndpoint = normalizeAndValidateLlmEndpoint(endpointToValidate);
  } else if (config.llmEndpoint !== undefined || config.llmProvider !== undefined) {
    config.llmEndpoint = null;
  }

  if (config.llmApiKey !== undefined) {
    const apiKeyValidation = validateApiKeyFormat(config.llmApiKey, targetProvider);
    if (!apiKeyValidation.valid) {
      throw new BotValidationError(apiKeyValidation.error || 'Invalid API key');
    }
  }
  
  // Build update object for bot config
  const botUpdateData: Partial<typeof bots.$inferInsert> = {
    updatedAt: new Date(),
  };
  
  // Build update object for bot's user account
  const userUpdateData: Partial<typeof users.$inferInsert> = {
    updatedAt: new Date(),
  };
  
  if (config.name !== undefined) {
    botUpdateData.name = config.name;
    userUpdateData.displayName = config.name;
  }
  
  if (config.bio !== undefined) {
    userUpdateData.bio = config.bio;
  }
  
  if (config.avatarUrl !== undefined) {
    userUpdateData.avatarUrl = config.avatarUrl;
  }
  
  if (config.headerUrl !== undefined) {
    userUpdateData.headerUrl = config.headerUrl;
  }
  
  if (config.personality !== undefined) {
    botUpdateData.personalityConfig = JSON.stringify(config.personality);
  }
  
  if (config.llmProvider !== undefined) {
    botUpdateData.llmProvider = config.llmProvider;
  }
  
  if (config.llmModel !== undefined) {
    botUpdateData.llmModel = config.llmModel;
  }

  if (config.llmEndpoint !== undefined) {
    botUpdateData.llmEndpoint = config.llmEndpoint;
  } else if (config.llmProvider !== undefined && config.llmProvider !== 'custom') {
    botUpdateData.llmEndpoint = null;
  }
  
  if (config.llmApiKey !== undefined) {
    const encryptedApiKey = encryptApiKey(config.llmApiKey);
    botUpdateData.llmApiKeyEncrypted = serializeEncryptedData(encryptedApiKey);
  }
  
  if (config.schedule !== undefined) {
    botUpdateData.scheduleConfig = config.schedule ? JSON.stringify(config.schedule) : null;
  }
  
  if (config.autonomousMode !== undefined) {
    botUpdateData.autonomousMode = config.autonomousMode;
  }
  
  if (config.isActive !== undefined) {
    botUpdateData.isActive = config.isActive;
  }
  
  // Update the bot's user account if there are changes
  if (Object.keys(userUpdateData).length > 1) { // More than just updatedAt
    await db
      .update(users)
      .set(userUpdateData)
      .where(eq(users.id, existingBot.userId));
  }
  
  // Update the bot config
  const [updatedBot] = await db
    .update(bots)
    .set(botUpdateData)
    .where(eq(bots.id, botId))
    .returning();
  
  // Get updated user
  const updatedUser = await db.query.users.findFirst({
    where: eq(users.id, existingBot.userId),
  });
  
  return dbBotToBot(updatedBot, updatedUser!);
}

/**
 * Delete a bot and all associated data.
 * Also deletes the bot's user account.
 * 
 * @param botId - The ID of the bot to delete
 * @throws BotNotFoundError if bot doesn't exist
 * 
 * Validates: Requirements 1.4
 */
export async function deleteBot(botId: string): Promise<void> {
  // Check if bot exists
  const existingBot = await db.query.bots.findFirst({
    where: eq(bots.id, botId),
  });
  
  if (!existingBot) {
    throw new BotNotFoundError(botId);
  }
  
  // Delete the bot config first (cascade will handle related data)
  await db.delete(bots).where(eq(bots.id, botId));
  
  // Delete the bot's user account (cascade will handle posts, follows, etc.)
  await db.delete(users).where(eq(users.id, existingBot.userId));
}

/**
 * Get all bots owned by a user.
 * 
 * @param ownerId - The ID of the owner
 * @returns Array of bots belonging to the user
 * 
 * Validates: Requirements 1.3
 */
export async function getBotsByUser(ownerId: string): Promise<Bot[]> {
  const userBots = await db.query.bots.findMany({
    where: eq(bots.ownerId, ownerId),
    orderBy: (bots, { desc }) => [desc(bots.createdAt)],
  });
  
  // Get all bot user accounts
  const botUserIds = userBots.map(b => b.userId);
  const botUsers = await db.query.users.findMany({
    where: (users, { inArray }) => inArray(users.id, botUserIds),
  });
  
  const userMap = new Map(botUsers.map(u => [u.id, u]));
  
  return userBots.map(bot => {
    const botUser = userMap.get(bot.userId);
    if (!botUser) {
      throw new Error(`Bot user not found for bot ${bot.id}`);
    }
    return dbBotToBot(bot, botUser);
  });
}

/**
 * Get a bot by ID.
 * 
 * @param botId - The ID of the bot
 * @returns The bot or null if not found
 * 
 * Validates: Requirements 1.3
 */
export async function getBotById(botId: string): Promise<Bot | null> {
  const bot = await db.query.bots.findFirst({
    where: eq(bots.id, botId),
  });
  
  if (!bot) {
    return null;
  }
  
  // Get the bot's user account
  const botUser = await db.query.users.findFirst({
    where: eq(users.id, bot.userId),
  });
  
  if (!botUser) {
    return null;
  }
  
  return dbBotToBot(bot, botUser);
}

/**
 * Get a bot by handle.
 * 
 * @param handle - The handle of the bot
 * @returns The bot or null if not found
 */
export async function getBotByHandle(handle: string): Promise<Bot | null> {
  // Find the user with this handle that is a bot
  const botUser = await db.query.users.findFirst({
    where: and(
      eq(users.handle, handle.toLowerCase()),
      eq(users.isBot, true)
    ),
  });
  
  if (!botUser) {
    return null;
  }
  
  // Find the bot config for this user
  const bot = await db.query.bots.findFirst({
    where: eq(bots.userId, botUser.id),
  });
  
  if (!bot) {
    return null;
  }
  
  return dbBotToBot(bot, botUser);
}

/**
 * Get the count of bots for a user.
 * 
 * @param ownerId - The ID of the owner
 * @returns The number of bots the user has
 */
export async function getBotCountForUser(ownerId: string): Promise<number> {
  const [result] = await db
    .select({ count: count() })
    .from(bots)
    .where(eq(bots.ownerId, ownerId));
  
  return result.count;
}

/**
 * Check if a user can create more bots.
 * 
 * @param ownerId - The ID of the owner
 * @returns True if user can create more bots
 * 
 * Validates: Requirements 1.6
 */
export async function canUserCreateBot(ownerId: string): Promise<boolean> {
  const botCount = await getBotCountForUser(ownerId);
  return botCount < getMaxBotsPerUser();
}

/**
 * Check if a user owns a specific bot.
 * 
 * @param ownerId - The ID of the owner
 * @param botId - The ID of the bot
 * @returns True if the user owns the bot
 */
export async function userOwnsBot(ownerId: string, botId: string): Promise<boolean> {
  const bot = await db.query.bots.findFirst({
    where: and(eq(bots.id, botId), eq(bots.ownerId, ownerId)),
  });
  
  return bot !== undefined;
}

/**
 * Update the last post timestamp for a bot.
 * 
 * @param botId - The ID of the bot
 */
export async function updateBotLastPostAt(botId: string): Promise<void> {
  await db
    .update(bots)
    .set({ lastPostAt: new Date(), updatedAt: new Date() })
    .where(eq(bots.id, botId));
}


// ============================================
// API KEY MANAGEMENT FUNCTIONS
// ============================================

/**
 * Marker value used to indicate a removed/empty API key.
 * This is encrypted and stored when an API key is removed.
 */
const EMPTY_API_KEY_MARKER = '__REMOVED__';

/**
 * Set or update the API key for a bot.
 * 
 * @param botId - The ID of the bot
 * @param apiKey - The new API key
 * @param provider - Optional provider override (uses bot's current provider if not specified)
 * @throws BotNotFoundError if bot doesn't exist
 * @throws BotValidationError if API key format is invalid
 * 
 * Validates: Requirements 2.1, 2.2, 2.4
 */
export async function setApiKey(
  botId: string, 
  apiKey: string, 
  provider?: LLMProvider
): Promise<void> {
  // Check if bot exists
  const existingBot = await db.query.bots.findFirst({
    where: eq(bots.id, botId),
  });
  
  if (!existingBot) {
    throw new BotNotFoundError(botId);
  }
  
  // Use provided provider or bot's current provider
  const targetProvider = provider || existingBot.llmProvider as LLMProvider;
  
  // Validate API key format
  const validation = validateApiKeyFormat(apiKey, targetProvider);
  if (!validation.valid) {
    throw new BotValidationError(validation.error || 'Invalid API key format');
  }
  
  // Encrypt the API key
  const encryptedApiKey = encryptApiKey(apiKey);
  
  // Update the bot with the new API key
  const updateData: Partial<typeof bots.$inferInsert> = {
    llmApiKeyEncrypted: serializeEncryptedData(encryptedApiKey),
    updatedAt: new Date(),
  };
  
  // If provider was specified and different, update it too
  if (provider && provider !== existingBot.llmProvider) {
    updateData.llmProvider = provider;
  }
  
  await db
    .update(bots)
    .set(updateData)
    .where(eq(bots.id, botId));
}

/**
 * Remove the API key from a bot.
 * Since the llmApiKeyEncrypted field is NOT NULL, this sets it to an
 * encrypted marker value that indicates the key has been removed.
 * 
 * @param botId - The ID of the bot
 * @throws BotNotFoundError if bot doesn't exist
 * 
 * Validates: Requirements 2.4, 2.5
 */
export async function removeApiKey(botId: string): Promise<void> {
  // Check if bot exists
  const existingBot = await db.query.bots.findFirst({
    where: eq(bots.id, botId),
  });
  
  if (!existingBot) {
    throw new BotNotFoundError(botId);
  }
  
  // Encrypt the marker value to indicate removed key
  const encryptedMarker = encryptApiKey(EMPTY_API_KEY_MARKER);
  
  // Update the bot with the marker
  await db
    .update(bots)
    .set({
      llmApiKeyEncrypted: serializeEncryptedData(encryptedMarker),
      updatedAt: new Date(),
    })
    .where(eq(bots.id, botId));
}

/**
 * API key status information
 */
export interface ApiKeyStatus {
  /** Whether an API key is configured (not removed) */
  hasApiKey: boolean;
  /** The LLM provider configured for the bot */
  provider: LLMProvider;
  /** The LLM model configured for the bot */
  model: string;
}

/**
 * Get the API key status for a bot.
 * Returns whether an API key is configured (not the key itself).
 * 
 * @param botId - The ID of the bot
 * @returns API key status information
 * @throws BotNotFoundError if bot doesn't exist
 * 
 * Validates: Requirements 2.1, 2.2
 */
export async function getApiKeyStatus(botId: string): Promise<ApiKeyStatus> {
  // Get the bot with encrypted API key
  const bot = await db.query.bots.findFirst({
    where: eq(bots.id, botId),
  });
  
  if (!bot) {
    throw new BotNotFoundError(botId);
  }
  
  // Check if API key is configured (not the removed marker)
  let hasApiKey = false;
  
  try {
    const encryptedData = deserializeEncryptedData(bot.llmApiKeyEncrypted);
    const decryptedKey = decryptApiKey(encryptedData);
    hasApiKey = decryptedKey !== EMPTY_API_KEY_MARKER && decryptedKey.length > 0;
  } catch {
    // If decryption fails, consider key as not configured
    hasApiKey = false;
  }
  
  return {
    hasApiKey,
    provider: bot.llmProvider as LLMProvider,
    model: bot.llmModel,
  };
}

/**
 * Check if a bot has a valid API key configured.
 * 
 * @param botId - The ID of the bot
 * @returns True if the bot has a valid API key
 */
export async function botHasApiKey(botId: string): Promise<boolean> {
  try {
    const status = await getApiKeyStatus(botId);
    return status.hasApiKey;
  } catch {
    return false;
  }
}

/**
 * Get the decrypted API key for a bot (for internal use only).
 * This should only be used by the content generator when making LLM calls.
 * 
 * @param botId - The ID of the bot
 * @returns The decrypted API key or null if not configured
 * @throws BotNotFoundError if bot doesn't exist
 * 
 * Validates: Requirements 2.3
 */
export async function getDecryptedApiKey(botId: string): Promise<string | null> {
  // Get the bot with encrypted API key
  const bot = await db.query.bots.findFirst({
    where: eq(bots.id, botId),
  });
  
  if (!bot) {
    throw new BotNotFoundError(botId);
  }
  
  try {
    const encryptedData = deserializeEncryptedData(bot.llmApiKeyEncrypted);
    const decryptedKey = decryptApiKey(encryptedData);
    
    // Return null if it's the removed marker
    if (decryptedKey === EMPTY_API_KEY_MARKER) {
      return null;
    }
    
    return decryptedKey;
  } catch {
    return null;
  }
}
