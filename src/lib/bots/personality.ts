/**
 * Personality Configuration Module
 * 
 * Handles validation, storage, and retrieval of bot personality configurations.
 * Provides utilities for building LLM prompts with personality context.
 * 
 * Requirements: 3.1, 3.3, 3.4
 */

import { db, bots } from '@/db';
import { eq } from 'drizzle-orm';

// ============================================
// TYPES
// ============================================

/**
 * Personality configuration for a bot.
 * Defines the bot's voice, tone, and behavior patterns.
 * 
 * Validates: Requirements 3.1, 3.4
 */
export interface PersonalityConfig {
  /** System prompt that defines the bot's personality and behavior */
  systemPrompt: string;
  /** Temperature for LLM generation (0-2, higher = more creative) */
  temperature: number;
  /** Maximum tokens for LLM response */
  maxTokens: number;
  /** Optional response style descriptor (e.g., "formal", "casual", "technical") */
  responseStyle?: string;
}

/**
 * Validation result for personality configuration.
 */
export interface PersonalityValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Personality preset template.
 */
export interface PersonalityPreset {
  id: string;
  name: string;
  description: string;
  config: PersonalityConfig;
}

// ============================================
// CONSTANTS
// ============================================

/** Minimum system prompt length */
export const MIN_SYSTEM_PROMPT_LENGTH = 10;

/** Maximum system prompt length */
export const MAX_SYSTEM_PROMPT_LENGTH = 10000;

/** Minimum temperature value */
export const MIN_TEMPERATURE = 0;

/** Maximum temperature value */
export const MAX_TEMPERATURE = 2;

/** Minimum max tokens value */
export const MIN_MAX_TOKENS = 1;

/** Maximum max tokens value */
export const MAX_MAX_TOKENS = 100000;

/** Valid response styles */
export const VALID_RESPONSE_STYLES = [
  'formal',
  'casual',
  'technical',
  'friendly',
  'professional',
  'humorous',
  'educational',
  'concise',
  'detailed',
] as const;

export type ResponseStyle = typeof VALID_RESPONSE_STYLES[number];

// ============================================
// VALIDATION FUNCTIONS
// ============================================

/**
 * Validate a system prompt.
 * 
 * @param systemPrompt - The system prompt to validate
 * @returns Array of validation errors (empty if valid)
 */
export function validateSystemPrompt(systemPrompt: unknown): string[] {
  const errors: string[] = [];
  
  if (systemPrompt === undefined || systemPrompt === null) {
    errors.push('System prompt is required');
    return errors;
  }
  
  if (typeof systemPrompt !== 'string') {
    errors.push('System prompt must be a string');
    return errors;
  }
  
  const trimmed = systemPrompt.trim();
  
  if (trimmed.length < MIN_SYSTEM_PROMPT_LENGTH) {
    errors.push(`System prompt must be at least ${MIN_SYSTEM_PROMPT_LENGTH} characters`);
  }
  
  if (trimmed.length > MAX_SYSTEM_PROMPT_LENGTH) {
    errors.push(`System prompt must be ${MAX_SYSTEM_PROMPT_LENGTH} characters or less`);
  }
  
  return errors;
}

/**
 * Validate a temperature value.
 * 
 * @param temperature - The temperature to validate
 * @returns Array of validation errors (empty if valid)
 */
export function validateTemperature(temperature: unknown): string[] {
  const errors: string[] = [];
  
  if (temperature === undefined || temperature === null) {
    errors.push('Temperature is required');
    return errors;
  }
  
  if (typeof temperature !== 'number') {
    errors.push('Temperature must be a number');
    return errors;
  }
  
  if (isNaN(temperature)) {
    errors.push('Temperature must be a valid number');
    return errors;
  }
  
  if (temperature < MIN_TEMPERATURE) {
    errors.push(`Temperature must be at least ${MIN_TEMPERATURE}`);
  }
  
  if (temperature > MAX_TEMPERATURE) {
    errors.push(`Temperature must be at most ${MAX_TEMPERATURE}`);
  }
  
  return errors;
}

/**
 * Validate a maxTokens value.
 * 
 * @param maxTokens - The maxTokens to validate
 * @returns Array of validation errors (empty if valid)
 */
export function validateMaxTokens(maxTokens: unknown): string[] {
  const errors: string[] = [];
  
  if (maxTokens === undefined || maxTokens === null) {
    errors.push('Max tokens is required');
    return errors;
  }
  
  if (typeof maxTokens !== 'number') {
    errors.push('Max tokens must be a number');
    return errors;
  }
  
  if (isNaN(maxTokens)) {
    errors.push('Max tokens must be a valid number');
    return errors;
  }
  
  if (!Number.isInteger(maxTokens)) {
    errors.push('Max tokens must be an integer');
    return errors;
  }
  
  if (maxTokens < MIN_MAX_TOKENS) {
    errors.push(`Max tokens must be at least ${MIN_MAX_TOKENS}`);
  }
  
  if (maxTokens > MAX_MAX_TOKENS) {
    errors.push(`Max tokens must be at most ${MAX_MAX_TOKENS}`);
  }
  
  return errors;
}

/**
 * Validate a response style.
 * 
 * @param responseStyle - The response style to validate (optional)
 * @returns Array of validation errors (empty if valid)
 */
export function validateResponseStyle(responseStyle: unknown): string[] {
  const errors: string[] = [];
  
  // Response style is optional
  if (responseStyle === undefined || responseStyle === null) {
    return errors;
  }
  
  if (typeof responseStyle !== 'string') {
    errors.push('Response style must be a string');
    return errors;
  }
  
  // Allow any non-empty string for custom styles
  if (responseStyle.trim().length === 0) {
    errors.push('Response style cannot be empty if provided');
  }
  
  if (responseStyle.length > 100) {
    errors.push('Response style must be 100 characters or less');
  }
  
  return errors;
}

/**
 * Validate a complete personality configuration.
 * 
 * @param config - The personality configuration to validate
 * @returns Validation result with errors
 * 
 * Validates: Requirements 3.1, 3.4
 */
export function validatePersonalityConfig(config: unknown): PersonalityValidationResult {
  const errors: string[] = [];
  
  if (!config || typeof config !== 'object') {
    return {
      valid: false,
      errors: ['Personality configuration must be an object'],
    };
  }
  
  const configObj = config as Record<string, unknown>;
  
  // Validate each field
  errors.push(...validateSystemPrompt(configObj.systemPrompt));
  errors.push(...validateTemperature(configObj.temperature));
  errors.push(...validateMaxTokens(configObj.maxTokens));
  errors.push(...validateResponseStyle(configObj.responseStyle));
  
  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Check if a personality configuration is valid.
 * 
 * @param config - The personality configuration to check
 * @returns True if valid
 */
export function isValidPersonalityConfig(config: unknown): config is PersonalityConfig {
  return validatePersonalityConfig(config).valid;
}

// ============================================
// STORAGE AND RETRIEVAL FUNCTIONS
// ============================================

/**
 * Error thrown when personality operations fail.
 */
export class PersonalityError extends Error {
  constructor(message: string, public code: string) {
    super(message);
    this.name = 'PersonalityError';
  }
}

/**
 * Serialize a personality configuration for database storage.
 * 
 * @param config - The personality configuration to serialize
 * @returns JSON string representation
 */
export function serializePersonalityConfig(config: PersonalityConfig): string {
  return JSON.stringify(config);
}

/**
 * Deserialize a personality configuration from database storage.
 * 
 * @param json - The JSON string to deserialize
 * @returns Parsed personality configuration
 * @throws PersonalityError if parsing fails or config is invalid
 */
export function deserializePersonalityConfig(json: string): PersonalityConfig {
  try {
    const parsed = JSON.parse(json);
    const validation = validatePersonalityConfig(parsed);
    
    if (!validation.valid) {
      throw new PersonalityError(
        `Invalid personality configuration: ${validation.errors.join(', ')}`,
        'INVALID_CONFIG'
      );
    }
    
    return parsed as PersonalityConfig;
  } catch (error) {
    if (error instanceof PersonalityError) {
      throw error;
    }
    throw new PersonalityError(
      'Failed to parse personality configuration',
      'PARSE_ERROR'
    );
  }
}

/**
 * Get the personality configuration for a bot.
 * 
 * @param botId - The ID of the bot
 * @returns The personality configuration or null if bot not found
 * 
 * Validates: Requirements 3.1, 3.3
 */
export async function getPersonalityConfig(botId: string): Promise<PersonalityConfig | null> {
  const bot = await db.query.bots.findFirst({
    where: { id: botId },
    columns: {
      personalityConfig: true,
    },
  });
  
  if (!bot) {
    return null;
  }
  
  return deserializePersonalityConfig(bot.personalityConfig);
}

/**
 * Update the personality configuration for a bot.
 * 
 * @param botId - The ID of the bot
 * @param config - The new personality configuration
 * @throws PersonalityError if validation fails or bot not found
 * 
 * Validates: Requirements 3.1, 3.3
 */
export async function updatePersonalityConfig(
  botId: string,
  config: PersonalityConfig
): Promise<void> {
  // Validate the configuration
  const validation = validatePersonalityConfig(config);
  if (!validation.valid) {
    throw new PersonalityError(
      `Invalid personality configuration: ${validation.errors.join(', ')}`,
      'VALIDATION_ERROR'
    );
  }
  
  // Check if bot exists
  const existingBot = await db.query.bots.findFirst({
    where: { id: botId },
    columns: { id: true },
  });
  
  if (!existingBot) {
    throw new PersonalityError(`Bot not found: ${botId}`, 'BOT_NOT_FOUND');
  }
  
  // Update the personality configuration
  await db
    .update(bots)
    .set({
      personalityConfig: serializePersonalityConfig(config),
      updatedAt: new Date(),
    })
    .where(eq(bots.id, botId));
}

// ============================================
// LLM PROMPT BUILDING
// ============================================

/**
 * Options for building an LLM prompt.
 */
export interface PromptBuildOptions {
  /** The user message or content to respond to */
  userMessage?: string;
  /** Additional context to include */
  context?: string;
  /** Source content being referenced */
  sourceContent?: {
    title: string;
    content: string;
    url: string;
  };
  /** Conversation history for replies */
  conversationHistory?: Array<{
    role: 'user' | 'assistant';
    content: string;
  }>;
}

/**
 * Built LLM prompt ready for API call.
 */
export interface BuiltPrompt {
  /** System message with personality */
  systemMessage: string;
  /** User/assistant messages */
  messages: Array<{
    role: 'user' | 'assistant' | 'system';
    content: string;
  }>;
  /** Temperature setting */
  temperature: number;
  /** Max tokens setting */
  maxTokens: number;
}

/**
 * Build an LLM prompt with personality context.
 * 
 * @param personality - The bot's personality configuration
 * @param options - Options for building the prompt
 * @returns Built prompt ready for LLM API call
 * 
 * Validates: Requirements 3.2, 3.5
 */
export function buildPromptWithPersonality(
  personality: PersonalityConfig,
  options: PromptBuildOptions = {}
): BuiltPrompt {
  const messages: BuiltPrompt['messages'] = [];
  
  // Build system message with personality
  let systemMessage = personality.systemPrompt;
  
  // Add response style guidance if specified
  if (personality.responseStyle) {
    systemMessage += `\n\nResponse Style: ${personality.responseStyle}`;
  }
  
  // Add context if provided
  if (options.context) {
    systemMessage += `\n\nAdditional Context:\n${options.context}`;
  }
  
  messages.push({
    role: 'system',
    content: systemMessage,
  });
  
  // Add conversation history if provided
  if (options.conversationHistory && options.conversationHistory.length > 0) {
    for (const msg of options.conversationHistory) {
      messages.push({
        role: msg.role,
        content: msg.content,
      });
    }
  }
  
  // Build user message
  if (options.sourceContent) {
    const sourceMessage = `Please create a post about the following content:

Title: ${options.sourceContent.title}
URL: ${options.sourceContent.url}

Content:
${options.sourceContent.content}`;
    
    messages.push({
      role: 'user',
      content: sourceMessage,
    });
  } else if (options.userMessage) {
    messages.push({
      role: 'user',
      content: options.userMessage,
    });
  }
  
  return {
    systemMessage,
    messages,
    temperature: personality.temperature,
    maxTokens: personality.maxTokens,
  };
}

// ============================================
// PERSONALITY PRESETS
// ============================================

/**
 * Default personality presets for common bot types.
 */
export const PERSONALITY_PRESETS: PersonalityPreset[] = [
  {
    id: 'news-curator',
    name: 'News Curator',
    description: 'A professional news curator that shares and summarizes articles',
    config: {
      systemPrompt: `You are a professional news curator bot. Your role is to share interesting news articles with insightful commentary.

Guidelines:
- Provide brief, informative summaries of articles
- Add your own analysis or perspective when relevant
- Use a professional but accessible tone
- Include relevant hashtags when appropriate
- Keep posts concise and engaging`,
      temperature: 0.7,
      maxTokens: 500,
      responseStyle: 'professional',
    },
  },
  {
    id: 'tech-enthusiast',
    name: 'Tech Enthusiast',
    description: 'An enthusiastic tech commentator that shares technology news',
    config: {
      systemPrompt: `You are an enthusiastic technology commentator bot. You love sharing exciting tech news and developments.

Guidelines:
- Show genuine excitement about technological innovations
- Explain technical concepts in accessible terms
- Engage with the tech community
- Share opinions on industry trends
- Use appropriate tech-related hashtags`,
      temperature: 0.8,
      maxTokens: 500,
      responseStyle: 'friendly',
    },
  },
  {
    id: 'educational',
    name: 'Educational Bot',
    description: 'An educational bot that explains topics clearly',
    config: {
      systemPrompt: `You are an educational bot focused on sharing knowledge and explaining concepts clearly.

Guidelines:
- Break down complex topics into understandable parts
- Use examples and analogies when helpful
- Encourage curiosity and learning
- Cite sources when sharing facts
- Be patient and thorough in explanations`,
      temperature: 0.6,
      maxTokens: 800,
      responseStyle: 'educational',
    },
  },
  {
    id: 'casual-commenter',
    name: 'Casual Commenter',
    description: 'A casual, friendly bot for general commentary',
    config: {
      systemPrompt: `You are a friendly, casual bot that engages in conversations and shares interesting content.

Guidelines:
- Be conversational and approachable
- Share your thoughts naturally
- Engage with others in a friendly manner
- Keep things light and positive
- Use emojis sparingly but appropriately`,
      temperature: 0.9,
      maxTokens: 300,
      responseStyle: 'casual',
    },
  },
  {
    id: 'formal-analyst',
    name: 'Formal Analyst',
    description: 'A formal, analytical bot for serious commentary',
    config: {
      systemPrompt: `You are a formal analyst bot that provides thoughtful, well-reasoned commentary.

Guidelines:
- Maintain a professional, formal tone
- Provide balanced analysis
- Support opinions with reasoning
- Avoid casual language and slang
- Focus on substance over style`,
      temperature: 0.5,
      maxTokens: 600,
      responseStyle: 'formal',
    },
  },
];

/**
 * Get a personality preset by ID.
 * 
 * @param presetId - The ID of the preset
 * @returns The preset or undefined if not found
 */
export function getPersonalityPreset(presetId: string): PersonalityPreset | undefined {
  return PERSONALITY_PRESETS.find(preset => preset.id === presetId);
}

/**
 * Get all available personality presets.
 * 
 * @returns Array of all presets
 */
export function getAllPersonalityPresets(): PersonalityPreset[] {
  return [...PERSONALITY_PRESETS];
}

/**
 * Create a default personality configuration.
 * 
 * @returns A default personality configuration
 */
export function createDefaultPersonalityConfig(): PersonalityConfig {
  return {
    systemPrompt: 'You are a helpful bot that shares interesting content and engages with users.',
    temperature: 0.7,
    maxTokens: 500,
  };
}
