/**
 * LLM Client Module
 * 
 * Provides a unified interface for generating completions from multiple LLM providers:
 * - OpenRouter
 * - OpenAI
 * - Anthropic
 * 
 * Includes retry logic with exponential backoff (3 retries).
 * 
 * Requirements: 2.6, 11.4
 */

import { decryptApiKey, deserializeEncryptedData, LLMProvider } from './encryption';

// ============================================
// TYPES
// ============================================

/**
 * LLM configuration for a bot.
 */
export interface LLMConfig {
  provider: LLMProvider;
  apiKey: string; // Encrypted before storage
  model: string;
  endpoint?: string | null;
}

/**
 * Message format for LLM requests.
 */
export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Request options for LLM completion.
 */
export interface LLMCompletionRequest {
  messages: LLMMessage[];
  temperature?: number;
  maxTokens?: number;
}

/**
 * Response from LLM completion.
 */
export interface LLMCompletionResponse {
  content: string;
  tokensUsed: {
    prompt: number;
    completion: number;
    total: number;
  };
  model: string;
  provider: LLMProvider;
}

/**
 * Error thrown by LLM client operations.
 */
export class LLMClientError extends Error {
  constructor(
    message: string,
    public code: LLMErrorCode,
    public provider: LLMProvider,
    public statusCode?: number,
    public retryable: boolean = false
  ) {
    super(message);
    this.name = 'LLMClientError';
  }
}

/**
 * Error codes for LLM client errors.
 */
export type LLMErrorCode =
  | 'AUTHENTICATION_ERROR'
  | 'RATE_LIMIT_ERROR'
  | 'INVALID_REQUEST'
  | 'CONTENT_POLICY_VIOLATION'
  | 'SERVER_ERROR'
  | 'NETWORK_ERROR'
  | 'TIMEOUT_ERROR'
  | 'UNKNOWN_ERROR';

/**
 * Retry configuration.
 */
export interface RetryConfig {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
}

// ============================================
// CONSTANTS
// ============================================

/**
 * Default retry configuration.
 * 3 retries with exponential backoff.
 */
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 10000,
  backoffMultiplier: 2,
};

/**
 * Default timeout for API requests (30 seconds).
 */
export const DEFAULT_TIMEOUT_MS = 30000;

/**
 * API endpoints for each provider.
 */
export const PROVIDER_ENDPOINTS: Record<LLMProvider, string> = {
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
  openai: 'https://api.openai.com/v1/chat/completions',
  anthropic: 'https://api.anthropic.com/v1/messages',
  custom: '',
};

/**
 * Default models for each provider.
 */
export const DEFAULT_MODELS: Record<LLMProvider, string> = {
  openrouter: 'openai/gpt-3.5-turbo',
  openai: 'gpt-3.5-turbo',
  anthropic: 'claude-3-haiku-20240307',
  custom: 'gpt-4o-mini',
};

// ============================================
// UTILITY FUNCTIONS
// ============================================

/**
 * Sleep for a specified duration.
 * 
 * @param ms - Duration in milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Calculate delay for retry attempt with exponential backoff.
 * 
 * @param attempt - Current attempt number (0-indexed)
 * @param config - Retry configuration
 * @returns Delay in milliseconds
 */
export function calculateRetryDelay(attempt: number, config: RetryConfig): number {
  const delay = config.initialDelayMs * Math.pow(config.backoffMultiplier, attempt);
  return Math.min(delay, config.maxDelayMs);
}

/**
 * Determine if an error is retryable.
 * 
 * @param error - The error to check
 * @returns True if the error is retryable
 */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof LLMClientError) {
    return error.retryable;
  }
  
  // Network errors are generally retryable
  if (error instanceof TypeError && error.message.includes('fetch')) {
    return true;
  }
  
  return false;
}

/**
 * Map HTTP status code to error code.
 * 
 * @param statusCode - HTTP status code
 * @returns LLM error code
 */
export function mapStatusToErrorCode(statusCode: number): { code: LLMErrorCode; retryable: boolean } {
  switch (statusCode) {
    case 401:
    case 403:
      return { code: 'AUTHENTICATION_ERROR', retryable: false };
    case 429:
      return { code: 'RATE_LIMIT_ERROR', retryable: true };
    case 400:
      return { code: 'INVALID_REQUEST', retryable: false };
    case 500:
    case 502:
    case 503:
    case 504:
      return { code: 'SERVER_ERROR', retryable: true };
    default:
      return { code: 'UNKNOWN_ERROR', retryable: false };
  }
}

// ============================================
// PROVIDER-SPECIFIC IMPLEMENTATIONS
// ============================================

/**
 * Build request body for OpenRouter API.
 */
export function buildOpenRouterRequest(
  request: LLMCompletionRequest,
  model: string
): Record<string, unknown> {
  return {
    model,
    messages: request.messages.map(msg => ({
      role: msg.role,
      content: msg.content,
    })),
    temperature: request.temperature ?? 0.7,
    max_tokens: request.maxTokens ?? 500,
  };
}

/**
 * Build request body for OpenAI API.
 */
export function buildOpenAIRequest(
  request: LLMCompletionRequest,
  model: string
): Record<string, unknown> {
  return {
    model,
    messages: request.messages.map(msg => ({
      role: msg.role,
      content: msg.content,
    })),
    temperature: request.temperature ?? 0.7,
    max_tokens: request.maxTokens ?? 500,
  };
}

/**
 * Build request body for Anthropic API.
 * Anthropic has a different message format - system message is separate.
 */
export function buildAnthropicRequest(
  request: LLMCompletionRequest,
  model: string
): Record<string, unknown> {
  // Extract system message if present
  const systemMessage = request.messages.find(msg => msg.role === 'system');
  const otherMessages = request.messages.filter(msg => msg.role !== 'system');
  
  const body: Record<string, unknown> = {
    model,
    messages: otherMessages.map(msg => ({
      role: msg.role,
      content: msg.content,
    })),
    temperature: request.temperature ?? 0.7,
    max_tokens: request.maxTokens ?? 500,
  };
  
  if (systemMessage) {
    body.system = systemMessage.content;
  }
  
  return body;
}

/**
 * Parse response from OpenRouter API.
 */
export function parseOpenRouterResponse(
  data: Record<string, unknown>,
  model: string
): LLMCompletionResponse {
  const choices = data.choices as Array<{ message: { content: string } }>;
  const usage = data.usage as { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  
  return {
    content: choices[0]?.message?.content ?? '',
    tokensUsed: {
      prompt: usage?.prompt_tokens ?? 0,
      completion: usage?.completion_tokens ?? 0,
      total: usage?.total_tokens ?? 0,
    },
    model: (data.model as string) ?? model,
    provider: 'openrouter',
  };
}

/**
 * Parse response from OpenAI API.
 */
export function parseOpenAIResponse(
  data: Record<string, unknown>,
  model: string,
  provider: LLMProvider = 'openai'
): LLMCompletionResponse {
  const choices = data.choices as Array<{ message: { content: string } }>;
  const usage = data.usage as { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  
  return {
    content: choices[0]?.message?.content ?? '',
    tokensUsed: {
      prompt: usage?.prompt_tokens ?? 0,
      completion: usage?.completion_tokens ?? 0,
      total: usage?.total_tokens ?? 0,
    },
    model: (data.model as string) ?? model,
    provider,
  };
}

/**
 * Parse response from Anthropic API.
 */
export function parseAnthropicResponse(
  data: Record<string, unknown>,
  model: string
): LLMCompletionResponse {
  const content = data.content as Array<{ type: string; text: string }>;
  const usage = data.usage as { input_tokens: number; output_tokens: number };
  
  // Anthropic returns content as an array of content blocks
  const textContent = content
    ?.filter(block => block.type === 'text')
    .map(block => block.text)
    .join('') ?? '';
  
  return {
    content: textContent,
    tokensUsed: {
      prompt: usage?.input_tokens ?? 0,
      completion: usage?.output_tokens ?? 0,
      total: (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0),
    },
    model: (data.model as string) ?? model,
    provider: 'anthropic',
  };
}

/**
 * Build headers for API request.
 */
export function buildHeaders(provider: LLMProvider, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  
  switch (provider) {
    case 'openrouter':
      headers['Authorization'] = `Bearer ${apiKey}`;
      headers['HTTP-Referer'] = 'https://synapsis.social'; // Required by OpenRouter
      headers['X-Title'] = 'Synapsis Bot';
      break;
    case 'openai':
    case 'custom':
      headers['Authorization'] = `Bearer ${apiKey}`;
      break;
    case 'anthropic':
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
      break;
  }
  
  return headers;
}

// ============================================
// LLM CLIENT CLASS
// ============================================

/**
 * LLM Client for generating completions from multiple providers.
 * 
 * Supports OpenRouter, OpenAI, and Anthropic with unified interface.
 * Includes retry logic with exponential backoff.
 * 
 * Validates: Requirements 2.6, 11.4
 */
export class LLMClient {
  private provider: LLMProvider;
  private apiKey: string;
  private model: string;
  private endpoint: string | null;
  private retryConfig: RetryConfig;
  private timeoutMs: number;
  
  /**
   * Create a new LLM client.
   * 
   * @param config - LLM configuration
   * @param retryConfig - Optional retry configuration
   * @param timeoutMs - Optional timeout in milliseconds
   */
  constructor(
    config: LLMConfig,
    retryConfig: RetryConfig = DEFAULT_RETRY_CONFIG,
    timeoutMs: number = DEFAULT_TIMEOUT_MS
  ) {
    this.provider = config.provider;
    this.model = config.model || DEFAULT_MODELS[config.provider];
    this.endpoint = config.endpoint || null;
    this.retryConfig = retryConfig;
    this.timeoutMs = timeoutMs;
    
    // Decrypt API key if it's encrypted (JSON format)
    try {
      const encryptedData = deserializeEncryptedData(config.apiKey);
      this.apiKey = decryptApiKey(encryptedData);
    } catch {
      // If deserialization fails, assume it's a plain API key (for testing)
      this.apiKey = config.apiKey;
    }
  }
  
  /**
   * Get the provider for this client.
   */
  getProvider(): LLMProvider {
    return this.provider;
  }
  
  /**
   * Get the model for this client.
   */
  getModel(): string {
    return this.model;
  }
  
  /**
   * Generate a completion from the LLM.
   * 
   * @param request - Completion request
   * @returns Completion response
   * @throws LLMClientError if the request fails after all retries
   * 
   * Validates: Requirements 2.6, 11.4
   */
  async generateCompletion(request: LLMCompletionRequest): Promise<LLMCompletionResponse> {
    let lastError: Error | null = null;
    
    for (let attempt = 0; attempt <= this.retryConfig.maxRetries; attempt++) {
      try {
        return await this.makeRequest(request);
      } catch (error) {
        lastError = error as Error;
        
        // Check if we should retry
        if (attempt < this.retryConfig.maxRetries && isRetryableError(error)) {
          const delay = calculateRetryDelay(attempt, this.retryConfig);
          await sleep(delay);
          continue;
        }
        
        // Don't retry non-retryable errors
        if (!isRetryableError(error)) {
          throw error;
        }
      }
    }
    
    // All retries exhausted
    throw lastError ?? new LLMClientError(
      'All retries exhausted',
      'UNKNOWN_ERROR',
      this.provider,
      undefined,
      false
    );
  }
  
  /**
   * Make a single API request without retry logic.
   * 
   * @param request - Completion request
   * @returns Completion response
   * @throws LLMClientError if the request fails
   */
  private async makeRequest(request: LLMCompletionRequest): Promise<LLMCompletionResponse> {
    const endpoint = this.provider === 'custom' ? this.endpoint : PROVIDER_ENDPOINTS[this.provider];
    if (!endpoint) {
      throw new LLMClientError(
        'Custom provider requires an endpoint',
        'INVALID_REQUEST',
        this.provider,
        undefined,
        false
      );
    }
    const headers = buildHeaders(this.provider, this.apiKey);
    const body = this.buildRequestBody(request);
    
    // Create abort controller for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const { code, retryable } = mapStatusToErrorCode(response.status);
        
        // Check for content policy violation
        const errorMessage = (errorData as Record<string, unknown>).error?.toString() ?? '';
        const isContentPolicy = errorMessage.toLowerCase().includes('content policy') ||
                               errorMessage.toLowerCase().includes('safety') ||
                               response.status === 400 && errorMessage.toLowerCase().includes('flagged');
        
        throw new LLMClientError(
          `${this.provider} API error: ${response.status} - ${JSON.stringify(errorData)}`,
          isContentPolicy ? 'CONTENT_POLICY_VIOLATION' : code,
          this.provider,
          response.status,
          retryable
        );
      }
      
      const data = await response.json() as Record<string, unknown>;
      return this.parseResponse(data);
    } catch (error) {
      clearTimeout(timeoutId);
      
      if (error instanceof LLMClientError) {
        throw error;
      }
      
      // Handle abort (timeout)
      if (error instanceof Error && error.name === 'AbortError') {
        throw new LLMClientError(
          `Request timed out after ${this.timeoutMs}ms`,
          'TIMEOUT_ERROR',
          this.provider,
          undefined,
          true
        );
      }
      
      // Handle network errors
      if (error instanceof TypeError) {
        throw new LLMClientError(
          `Network error: ${error.message}`,
          'NETWORK_ERROR',
          this.provider,
          undefined,
          true
        );
      }
      
      throw new LLMClientError(
        `Unknown error: ${error instanceof Error ? error.message : String(error)}`,
        'UNKNOWN_ERROR',
        this.provider,
        undefined,
        false
      );
    }
  }
  
  /**
   * Build request body based on provider.
   */
  private buildRequestBody(request: LLMCompletionRequest): Record<string, unknown> {
    switch (this.provider) {
      case 'openrouter':
        return buildOpenRouterRequest(request, this.model);
      case 'openai':
      case 'custom':
        return buildOpenAIRequest(request, this.model);
      case 'anthropic':
        return buildAnthropicRequest(request, this.model);
    }
  }
  
  /**
   * Parse response based on provider.
   */
  private parseResponse(data: Record<string, unknown>): LLMCompletionResponse {
    switch (this.provider) {
      case 'openrouter':
        return parseOpenRouterResponse(data, this.model);
      case 'openai':
        return parseOpenAIResponse(data, this.model, 'openai');
      case 'custom':
        return parseOpenAIResponse(data, this.model, 'custom');
      case 'anthropic':
        return parseAnthropicResponse(data, this.model);
    }
  }
}

// ============================================
// FACTORY FUNCTIONS
// ============================================

/**
 * Create an LLM client from configuration.
 * 
 * @param config - LLM configuration
 * @param retryConfig - Optional retry configuration
 * @returns LLM client instance
 * 
 * Validates: Requirements 2.6
 */
export function createLLMClient(
  config: LLMConfig,
  retryConfig?: RetryConfig
): LLMClient {
  return new LLMClient(config, retryConfig);
}

/**
 * Create an LLM client from bot data.
 * 
 * @param provider - LLM provider
 * @param encryptedApiKey - Encrypted API key (JSON string)
 * @param model - Model name
 * @returns LLM client instance
 */
export function createLLMClientFromBot(
  provider: LLMProvider,
  encryptedApiKey: string,
  model: string,
  endpoint?: string | null
): LLMClient {
  return new LLMClient({
    provider,
    apiKey: encryptedApiKey,
    model,
    endpoint,
  });
}

/**
 * Validate LLM configuration.
 * 
 * @param config - Configuration to validate
 * @returns Validation result
 */
export function validateLLMConfig(config: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  
  if (!config || typeof config !== 'object') {
    return { valid: false, errors: ['Configuration must be an object'] };
  }
  
  const configObj = config as Record<string, unknown>;
  
  // Validate provider
  const validProviders: LLMProvider[] = ['openrouter', 'openai', 'anthropic', 'custom'];
  if (!configObj.provider || !validProviders.includes(configObj.provider as LLMProvider)) {
    errors.push(`Provider must be one of: ${validProviders.join(', ')}`);
  }
  
  // Validate API key
  if (!configObj.apiKey || typeof configObj.apiKey !== 'string') {
    errors.push('API key is required and must be a string');
  }
  
  // Validate model (optional but must be string if provided)
  if (configObj.model !== undefined && typeof configObj.model !== 'string') {
    errors.push('Model must be a string');
  }

  if (configObj.provider === 'custom' && (!configObj.endpoint || typeof configObj.endpoint !== 'string')) {
    errors.push('Endpoint is required for custom provider');
  }
  
  return { valid: errors.length === 0, errors };
}
