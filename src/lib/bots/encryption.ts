/**
 * Bot API Key Encryption Module
 * 
 * Provides AES-256-GCM encryption for API keys and format validation
 * for supported LLM providers (OpenRouter, OpenAI, Anthropic).
 * 
 * Requirements: 2.1, 2.2, 2.3, 10.3
 */

import * as crypto from 'crypto';

// ============================================
// TYPES
// ============================================

export type LLMProvider = 'openrouter' | 'openai' | 'anthropic' | 'custom';

export interface EncryptedData {
  encrypted: string;  // Base64 encoded ciphertext + auth tag
  iv: string;         // Base64 encoded initialization vector
}

export interface ApiKeyValidationResult {
  valid: boolean;
  provider?: LLMProvider;
  error?: string;
}

// ============================================
// CONSTANTS
// ============================================

/**
 * API key format patterns for supported providers
 * - OpenRouter: typically starts with "sk-or-"
 * - OpenAI: typically starts with "sk-" (but not "sk-or-" or "sk-ant-")
 * - Anthropic: typically starts with "sk-ant-"
 */
const API_KEY_PATTERNS: Record<LLMProvider, RegExp> = {
  openrouter: /^sk-or-[a-zA-Z0-9_-]+$/,
  anthropic: /^sk-ant-[a-zA-Z0-9_-]+$/,
  openai: /^sk-[a-zA-Z0-9_-]+$/,
  custom: /^[\s\S]+$/,
};

/**
 * Minimum length for API keys (security requirement)
 */
const MIN_API_KEY_LENGTH = 20;

/**
 * Maximum length for API keys (sanity check)
 */
const MAX_API_KEY_LENGTH = 256;

// ============================================
// ENCRYPTION KEY MANAGEMENT
// ============================================

/**
 * Get the encryption key from environment variables.
 * Uses AUTH_SECRET as the encryption key.
 * 
 * @throws Error if AUTH_SECRET is not set
 */
function getEncryptionKey(): Buffer {
  const keyEnv = process.env.AUTH_SECRET;
  
  if (!keyEnv) {
    throw new Error('AUTH_SECRET environment variable is not set');
  }
  
  // Create a 32-byte key from AUTH_SECRET using SHA-256
  return crypto.createHash('sha256').update(keyEnv).digest();
}

// ============================================
// ENCRYPTION FUNCTIONS
// ============================================

/**
 * Encrypt an API key using AES-256-GCM.
 * 
 * @param apiKey - The plaintext API key to encrypt
 * @returns EncryptedData containing the encrypted key and IV
 * @throws Error if encryption fails or encryption key is not configured
 * 
 * Validates: Requirements 2.2, 10.3
 */
export function encryptApiKey(apiKey: string): EncryptedData {
  if (!apiKey || typeof apiKey !== 'string') {
    throw new Error('API key must be a non-empty string');
  }
  
  const key = getEncryptionKey();
  
  // Generate a random 16-byte IV for each encryption
  const iv = crypto.randomBytes(16);
  
  // Create cipher with AES-256-GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  
  // Encrypt the API key
  let encrypted = cipher.update(apiKey, 'utf8');
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  
  // Get the authentication tag (16 bytes for GCM)
  const authTag = cipher.getAuthTag();
  
  // Combine encrypted data with auth tag
  const combined = Buffer.concat([encrypted, authTag]);
  
  return {
    encrypted: combined.toString('base64'),
    iv: iv.toString('base64'),
  };
}

/**
 * Decrypt an encrypted API key using AES-256-GCM.
 * 
 * @param encryptedData - The encrypted data containing ciphertext and IV
 * @returns The decrypted plaintext API key
 * @throws Error if decryption fails or data is tampered
 * 
 * Validates: Requirements 2.3
 */
export function decryptApiKey(encryptedData: EncryptedData): string {
  if (!encryptedData || !encryptedData.encrypted || !encryptedData.iv) {
    throw new Error('Invalid encrypted data: missing required fields');
  }
  
  const key = getEncryptionKey();
  
  // Decode the IV
  const iv = Buffer.from(encryptedData.iv, 'base64');
  if (iv.length !== 16) {
    throw new Error('Invalid IV length');
  }
  
  // Decode the combined encrypted data + auth tag
  const combined = Buffer.from(encryptedData.encrypted, 'base64');
  
  // Separate the auth tag (last 16 bytes) from the encrypted data
  if (combined.length < 17) {
    throw new Error('Invalid encrypted data: too short');
  }
  
  const authTag = combined.subarray(combined.length - 16);
  const encryptedBuffer = combined.subarray(0, combined.length - 16);
  
  // Create decipher
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  
  // Decrypt
  let decrypted = decipher.update(encryptedBuffer);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  
  return decrypted.toString('utf8');
}

/**
 * Serialize encrypted data to a JSON string for database storage.
 * 
 * @param encryptedData - The encrypted data to serialize
 * @returns JSON string representation
 */
export function serializeEncryptedData(encryptedData: EncryptedData): string {
  return JSON.stringify(encryptedData);
}

/**
 * Deserialize encrypted data from a JSON string (from database).
 * 
 * @param serialized - The JSON string to deserialize
 * @returns EncryptedData object
 * @throws Error if the string is not valid JSON or missing required fields
 */
export function deserializeEncryptedData(serialized: string): EncryptedData {
  if (!serialized || typeof serialized !== 'string') {
    throw new Error('Invalid serialized data: must be a non-empty string');
  }
  
  try {
    const parsed = JSON.parse(serialized);
    
    if (!parsed.encrypted || !parsed.iv) {
      throw new Error('Invalid encrypted data format: missing required fields');
    }
    
    return {
      encrypted: parsed.encrypted,
      iv: parsed.iv,
    };
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error('Invalid serialized data: not valid JSON');
    }
    throw error;
  }
}

// ============================================
// API KEY VALIDATION
// ============================================

/**
 * Validate an API key format for a specific provider.
 * 
 * @param apiKey - The API key to validate
 * @param provider - The LLM provider type
 * @returns Validation result with validity status and any error message
 * 
 * Validates: Requirements 2.1
 */
export function validateApiKeyFormat(apiKey: string, provider: LLMProvider): ApiKeyValidationResult {
  // Basic validation
  if (!apiKey || typeof apiKey !== 'string') {
    return {
      valid: false,
      error: 'API key must be a non-empty string',
    };
  }
  
  // Length validation
  if (apiKey.length < MIN_API_KEY_LENGTH) {
    return {
      valid: false,
      error: `API key is too short (minimum ${MIN_API_KEY_LENGTH} characters)`,
    };
  }
  
  if (apiKey.length > MAX_API_KEY_LENGTH) {
    return {
      valid: false,
      error: `API key is too long (maximum ${MAX_API_KEY_LENGTH} characters)`,
    };
  }
  
  // Provider validation
  if (!API_KEY_PATTERNS[provider]) {
    return {
      valid: false,
      error: `Unsupported provider: ${provider}`,
    };
  }
  
  // For OpenAI, we need to ensure it doesn't match OpenRouter or Anthropic patterns
  if (provider === 'openai') {
    // OpenAI keys start with "sk-" but NOT "sk-or-" or "sk-ant-"
    if (apiKey.startsWith('sk-or-')) {
      return {
        valid: false,
        error: 'This appears to be an OpenRouter key, not an OpenAI key',
      };
    }
    if (apiKey.startsWith('sk-ant-')) {
      return {
        valid: false,
        error: 'This appears to be an Anthropic key, not an OpenAI key',
      };
    }
  }
  
  // Check against provider pattern
  const pattern = API_KEY_PATTERNS[provider];
  if (!pattern.test(apiKey)) {
    return {
      valid: false,
      error: `Invalid API key format for ${provider}`,
    };
  }
  
  return {
    valid: true,
    provider,
  };
}

/**
 * Detect the provider type from an API key based on its format.
 * 
 * @param apiKey - The API key to analyze
 * @returns The detected provider or null if unknown
 */
export function detectProviderFromApiKey(apiKey: string): LLMProvider | null {
  if (!apiKey || typeof apiKey !== 'string') {
    return null;
  }
  
  // Check in order of specificity (most specific prefixes first)
  if (apiKey.startsWith('sk-or-')) {
    return 'openrouter';
  }
  
  if (apiKey.startsWith('sk-ant-')) {
    return 'anthropic';
  }
  
  if (apiKey.startsWith('sk-')) {
    return 'openai';
  }
  
  return null;
}

/**
 * Validate an API key and detect its provider automatically.
 * 
 * @param apiKey - The API key to validate
 * @returns Validation result with detected provider
 */
export function validateAndDetectApiKey(apiKey: string): ApiKeyValidationResult {
  const provider = detectProviderFromApiKey(apiKey);
  
  if (!provider) {
    return {
      valid: false,
      error: 'Unable to detect API key provider. Key must start with sk-or- (OpenRouter), sk-ant- (Anthropic), or sk- (OpenAI)',
    };
  }
  
  return validateApiKeyFormat(apiKey, provider);
}

/**
 * Check if a provider is supported.
 * 
 * @param provider - The provider string to check
 * @returns True if the provider is supported
 */
export function isSupportedProvider(provider: string): provider is LLMProvider {
  return provider === 'openrouter' || provider === 'openai' || provider === 'anthropic' || provider === 'custom';
}

/**
 * Get the list of supported providers.
 * 
 * @returns Array of supported provider names
 */
export function getSupportedProviders(): LLMProvider[] {
  return ['openrouter', 'openai', 'anthropic', 'custom'];
}
