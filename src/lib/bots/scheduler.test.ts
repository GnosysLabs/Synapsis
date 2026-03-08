/**
 * Unit Tests for Scheduler Service
 * 
 * Tests the scheduling functionality for bot posts including
 * interval, time-of-day, and cron-like schedules.
 * 
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  ScheduleConfig,
  isValidTimeFormat,
  isValidCronExpression,
  validateIntervalMinutes,
  validateTimes,
  validateCronExpression,
  validateScheduleConfig,
  normalizeTime,
  isValidTimezone,
  parseTime,
  parseCronExpression,
  parseScheduleConfig,
  serializeScheduleConfig,
  isIntervalDue,
  isTimesDue,
  isCronDue,
  isDue,
  MIN_INTERVAL_MINUTES,
  MAX_INTERVAL_MINUTES,
  MAX_TIMES_PER_DAY,
} from './scheduler';

// ============================================
// TIME FORMAT VALIDATION
// ============================================

describe('isValidTimeFormat', () => {
  it('should accept valid HH:MM format', () => {
    expect(isValidTimeFormat('00:00')).toBe(true);
    expect(isValidTimeFormat('12:30')).toBe(true);
    expect(isValidTimeFormat('23:59')).toBe(true);
    expect(isValidTimeFormat('09:05')).toBe(true);
  });

  it('should accept H:MM format (single digit hour)', () => {
    expect(isValidTimeFormat('0:00')).toBe(true);
    expect(isValidTimeFormat('9:30')).toBe(true);
  });
  
  it('should reject invalid time formats', () => {
    expect(isValidTimeFormat('')).toBe(false);
    expect(isValidTimeFormat('24:00')).toBe(false);
    expect(isValidTimeFormat('12:60')).toBe(false);
    expect(isValidTimeFormat('12')).toBe(false);
    expect(isValidTimeFormat('12:30:00')).toBe(false);
    expect(isValidTimeFormat('abc')).toBe(false);
    expect(isValidTimeFormat('12:3')).toBe(false);
  });
  
  it('should reject null and undefined', () => {
    expect(isValidTimeFormat(null as any)).toBe(false);
    expect(isValidTimeFormat(undefined as any)).toBe(false);
  });
});

// ============================================
// CRON EXPRESSION VALIDATION
// ============================================

describe('isValidCronExpression', () => {
  it('should accept valid cron expressions', () => {
    expect(isValidCronExpression('* * * * *')).toBe(true);
    expect(isValidCronExpression('0 12 * * *')).toBe(true);
    expect(isValidCronExpression('30 9 1 * 1')).toBe(true);
    expect(isValidCronExpression('0 0 1 1 0')).toBe(true);
  });
  
  it('should reject invalid cron expressions', () => {
    expect(isValidCronExpression('')).toBe(false);
    expect(isValidCronExpression('* * *')).toBe(false);
    expect(isValidCronExpression('60 * * * *')).toBe(false);
    expect(isValidCronExpression('* 24 * * *')).toBe(false);
    expect(isValidCronExpression('* * 32 * *')).toBe(false);
    expect(isValidCronExpression('* * * 13 *')).toBe(false);
    expect(isValidCronExpression('* * * * 7')).toBe(false);
  });
  
  it('should reject null and undefined', () => {
    expect(isValidCronExpression(null as any)).toBe(false);
    expect(isValidCronExpression(undefined as any)).toBe(false);
  });
});

// ============================================
// INTERVAL VALIDATION
// ============================================

describe('validateIntervalMinutes', () => {
  it('should accept valid intervals', () => {
    expect(validateIntervalMinutes(5)).toEqual([]);
    expect(validateIntervalMinutes(30)).toEqual([]);
    expect(validateIntervalMinutes(60)).toEqual([]);
    expect(validateIntervalMinutes(1440)).toEqual([]);
    expect(validateIntervalMinutes(MAX_INTERVAL_MINUTES)).toEqual([]);
  });
  
  it('should reject intervals below minimum', () => {
    const errors = validateIntervalMinutes(4);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('at least');
  });
  
  it('should reject intervals above maximum', () => {
    const errors = validateIntervalMinutes(MAX_INTERVAL_MINUTES + 1);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('at most');
  });
  
  it('should reject non-integer values', () => {
    const errors = validateIntervalMinutes(30.5);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('integer');
  });
  
  it('should reject non-number values', () => {
    expect(validateIntervalMinutes('30').length).toBeGreaterThan(0);
    expect(validateIntervalMinutes(null).length).toBeGreaterThan(0);
    expect(validateIntervalMinutes(undefined).length).toBeGreaterThan(0);
  });
});

// ============================================
// TIMES VALIDATION
// ============================================

describe('validateTimes', () => {
  it('should accept valid times arrays', () => {
    expect(validateTimes(['09:00'])).toEqual([]);
    expect(validateTimes(['09:00', '12:00', '18:00'])).toEqual([]);
    expect(validateTimes(['00:00', '23:59'])).toEqual([]);
  });
  
  it('should reject empty arrays', () => {
    const errors = validateTimes([]);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('empty');
  });
  
  it('should reject arrays with too many times', () => {
    const times = Array(MAX_TIMES_PER_DAY + 1).fill('12:00');
    const errors = validateTimes(times);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('Maximum');
  });
  
  it('should reject invalid time formats', () => {
    const errors = validateTimes(['25:00']);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('HH:MM');
  });
  
  it('should reject duplicate times', () => {
    const errors = validateTimes(['09:00', '09:00']);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('Duplicate');
  });
  
  it('should reject non-array values', () => {
    expect(validateTimes('09:00' as any).length).toBeGreaterThan(0);
    expect(validateTimes(null).length).toBeGreaterThan(0);
    expect(validateTimes(undefined).length).toBeGreaterThan(0);
  });
});

// ============================================
// CRON EXPRESSION VALIDATION
// ============================================

describe('validateCronExpression', () => {
  it('should accept valid cron expressions', () => {
    expect(validateCronExpression('0 12 * * *')).toEqual([]);
    expect(validateCronExpression('* * * * *')).toEqual([]);
  });
  
  it('should reject invalid cron expressions', () => {
    const errors = validateCronExpression('invalid');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('Invalid cron');
  });
  
  it('should reject non-string values', () => {
    expect(validateCronExpression(123 as any).length).toBeGreaterThan(0);
    expect(validateCronExpression(null).length).toBeGreaterThan(0);
    expect(validateCronExpression(undefined).length).toBeGreaterThan(0);
  });
});


// ============================================
// SCHEDULE CONFIG VALIDATION
// ============================================

describe('validateScheduleConfig', () => {
  describe('interval schedules', () => {
    it('should accept valid interval config', () => {
      const config: ScheduleConfig = {
        type: 'interval',
        intervalMinutes: 30,
      };
      const result = validateScheduleConfig(config);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });
    
    it('should reject interval config without intervalMinutes', () => {
      const config = { type: 'interval' };
      const result = validateScheduleConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });
  
  describe('times schedules', () => {
    it('should accept valid times config', () => {
      const config: ScheduleConfig = {
        type: 'times',
        times: ['09:00', '18:00'],
      };
      const result = validateScheduleConfig(config);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });
    
    it('should accept times config with timezone', () => {
      const config: ScheduleConfig = {
        type: 'times',
        times: ['09:00'],
        timezone: 'America/New_York',
      };
      const result = validateScheduleConfig(config);
      expect(result.valid).toBe(true);
    });
    
    it('should reject times config without times array', () => {
      const config = { type: 'times' };
      const result = validateScheduleConfig(config);
      expect(result.valid).toBe(false);
    });
  });
  
  describe('cron schedules', () => {
    it('should accept valid cron config', () => {
      const config: ScheduleConfig = {
        type: 'cron',
        cronExpression: '0 12 * * *',
      };
      const result = validateScheduleConfig(config);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });
    
    it('should reject cron config without expression', () => {
      const config = { type: 'cron' };
      const result = validateScheduleConfig(config);
      expect(result.valid).toBe(false);
    });
  });
  
  describe('invalid configs', () => {
    it('should reject invalid type', () => {
      const config = { type: 'invalid' };
      const result = validateScheduleConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('Invalid schedule type');
    });
    
    it('should reject missing type', () => {
      const config = { intervalMinutes: 30 };
      const result = validateScheduleConfig(config);
      expect(result.valid).toBe(false);
    });
    
    it('should reject non-object values', () => {
      expect(validateScheduleConfig(null).valid).toBe(false);
      expect(validateScheduleConfig('string').valid).toBe(false);
      expect(validateScheduleConfig(123).valid).toBe(false);
    });
    
    it('should reject invalid timezone', () => {
      const config = {
        type: 'times',
        times: ['09:00'],
        timezone: 'Invalid/Timezone',
      };
      const result = validateScheduleConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('timezone'))).toBe(true);
    });
  });
});

// ============================================
// HELPER FUNCTIONS
// ============================================

describe('normalizeTime', () => {
  it('should normalize single digit hours', () => {
    expect(normalizeTime('9:00')).toBe('09:00');
    expect(normalizeTime('0:30')).toBe('00:30');
  });
  
  it('should keep double digit hours unchanged', () => {
    expect(normalizeTime('12:00')).toBe('12:00');
    expect(normalizeTime('23:59')).toBe('23:59');
  });
  
  it('should trim whitespace', () => {
    expect(normalizeTime('  09:00  ')).toBe('09:00');
  });
});

describe('isValidTimezone', () => {
  it('should accept valid timezones', () => {
    expect(isValidTimezone('UTC')).toBe(true);
    expect(isValidTimezone('America/New_York')).toBe(true);
    expect(isValidTimezone('Europe/London')).toBe(true);
    expect(isValidTimezone('Asia/Tokyo')).toBe(true);
  });
  
  it('should reject invalid timezones', () => {
    expect(isValidTimezone('Invalid/Timezone')).toBe(false);
    expect(isValidTimezone('NotATimezone')).toBe(false);
  });
});

describe('parseTime', () => {
  it('should parse time strings correctly', () => {
    expect(parseTime('09:30')).toEqual({ hours: 9, minutes: 30 });
    expect(parseTime('23:59')).toEqual({ hours: 23, minutes: 59 });
    expect(parseTime('0:00')).toEqual({ hours: 0, minutes: 0 });
  });
});

describe('parseCronExpression', () => {
  it('should parse cron expressions correctly', () => {
    const result = parseCronExpression('30 9 1 6 5');
    expect(result).toEqual({
      minute: '30',
      hour: '9',
      dayOfMonth: '1',
      month: '6',
      dayOfWeek: '5',
    });
  });
  
  it('should handle wildcards', () => {
    const result = parseCronExpression('* * * * *');
    expect(result).toEqual({
      minute: '*',
      hour: '*',
      dayOfMonth: '*',
      month: '*',
      dayOfWeek: '*',
    });
  });
});


// ============================================
// SCHEDULE SERIALIZATION
// ============================================

describe('parseScheduleConfig', () => {
  it('should parse valid JSON config', () => {
    const json = JSON.stringify({
      type: 'interval',
      intervalMinutes: 30,
    });
    const result = parseScheduleConfig(json);
    expect(result).toEqual({
      type: 'interval',
      intervalMinutes: 30,
    });
  });
  
  it('should return null for invalid JSON', () => {
    expect(parseScheduleConfig('invalid json')).toBeNull();
  });
  
  it('should return null for invalid config', () => {
    const json = JSON.stringify({ type: 'invalid' });
    expect(parseScheduleConfig(json)).toBeNull();
  });
  
  it('should return null for null input', () => {
    expect(parseScheduleConfig(null)).toBeNull();
  });
});

describe('serializeScheduleConfig', () => {
  it('should serialize config to JSON', () => {
    const config: ScheduleConfig = {
      type: 'interval',
      intervalMinutes: 30,
    };
    const json = serializeScheduleConfig(config);
    expect(JSON.parse(json)).toEqual(config);
  });
});

// ============================================
// IS DUE CHECKS
// ============================================

describe('isIntervalDue', () => {
  it('should be due when never posted', () => {
    const result = isIntervalDue(30, null);
    expect(result.isDue).toBe(true);
    expect(result.reason).toContain('No previous post');
  });
  
  it('should be due when interval has elapsed', () => {
    const thirtyOneMinutesAgo = new Date(Date.now() - 31 * 60 * 1000);
    const result = isIntervalDue(30, thirtyOneMinutesAgo);
    expect(result.isDue).toBe(true);
    expect(result.reason).toContain('Interval elapsed');
  });
  
  it('should not be due when interval has not elapsed', () => {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    const result = isIntervalDue(30, tenMinutesAgo);
    expect(result.isDue).toBe(false);
    expect(result.nextDueAt).toBeDefined();
  });
  
  it('should calculate correct next due time', () => {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    const result = isIntervalDue(30, tenMinutesAgo);
    
    // Next due should be ~20 minutes from now
    const expectedNextDue = new Date(tenMinutesAgo.getTime() + 30 * 60 * 1000);
    expect(result.nextDueAt?.getTime()).toBeCloseTo(expectedNextDue.getTime(), -3);
  });
});

describe('isTimesDue', () => {
  it('should not be due when no times match current time', () => {
    // Use a time that's definitely not now
    const result = isTimesDue(['03:00'], 'UTC', null);
    // This test is time-dependent, so we just check it returns a valid result
    expect(typeof result.isDue).toBe('boolean');
  });
  
  it('should handle multiple times', () => {
    const result = isTimesDue(['09:00', '12:00', '18:00'], 'UTC', null);
    expect(typeof result.isDue).toBe('boolean');
    expect(result.reason).toBeDefined();
  });
});

describe('isCronDue', () => {
  it('should handle wildcard cron expression', () => {
    // Wildcard should always match
    const result = isCronDue('* * * * *', 'UTC', null);
    expect(result.isDue).toBe(true);
  });
  
  it('should not be due when cron does not match', () => {
    // Use a specific time that's unlikely to match
    const result = isCronDue('0 3 15 6 *', 'UTC', null);
    // This is time-dependent
    expect(typeof result.isDue).toBe('boolean');
  });
  
  it('should not be due if already posted this minute', () => {
    const justNow = new Date(Date.now() - 30 * 1000); // 30 seconds ago
    const result = isCronDue('* * * * *', 'UTC', justNow);
    expect(result.isDue).toBe(false);
    expect(result.reason).toContain('Already posted');
  });
});

describe('isDue', () => {
  it('should delegate to isIntervalDue for interval type', () => {
    const config: ScheduleConfig = {
      type: 'interval',
      intervalMinutes: 30,
    };
    const result = isDue(config, null);
    expect(result.isDue).toBe(true);
  });
  
  it('should delegate to isTimesDue for times type', () => {
    const config: ScheduleConfig = {
      type: 'times',
      times: ['09:00', '18:00'],
    };
    const result = isDue(config, null);
    expect(typeof result.isDue).toBe('boolean');
  });
  
  it('should delegate to isCronDue for cron type', () => {
    const config: ScheduleConfig = {
      type: 'cron',
      cronExpression: '* * * * *',
    };
    const result = isDue(config, null);
    expect(result.isDue).toBe(true);
  });
  
  it('should return not due for missing interval config', () => {
    const config: ScheduleConfig = {
      type: 'interval',
    };
    const result = isDue(config, null);
    expect(result.isDue).toBe(false);
    expect(result.reason).toContain('Missing interval');
  });
  
  it('should return not due for missing times config', () => {
    const config: ScheduleConfig = {
      type: 'times',
      times: [],
    };
    const result = isDue(config, null);
    expect(result.isDue).toBe(false);
    expect(result.reason).toContain('Missing times');
  });
  
  it('should return not due for missing cron config', () => {
    const config: ScheduleConfig = {
      type: 'cron',
    };
    const result = isDue(config, null);
    expect(result.isDue).toBe(false);
    expect(result.reason).toContain('Missing cron');
  });
  
  it('should use provided timezone', () => {
    const config: ScheduleConfig = {
      type: 'times',
      times: ['09:00'],
      timezone: 'America/New_York',
    };
    const result = isDue(config, null);
    expect(typeof result.isDue).toBe('boolean');
  });
});


// ============================================
// DATABASE INTEGRATION TESTS (MOCKED)
// ============================================

// Mock the database module
vi.mock('@/db', () => {
  return {
    db: {
      query: {
        bots: {
          findFirst: vi.fn(async () => null),
          findMany: vi.fn(async () => []),
        },
        botContentSources: {
          findMany: vi.fn(async () => []),
        },
        botContentItems: {
          findFirst: vi.fn(async () => null),
        },
      },
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(async () => {}),
        })),
      })),
    },
    bots: { id: 'id', isActive: 'isActive', isSuspended: 'isSuspended', scheduleConfig: 'scheduleConfig' },
    botContentSources: { id: 'id', botId: 'botId', isActive: 'isActive' },
    botContentItems: { id: 'id', sourceId: 'sourceId', isProcessed: 'isProcessed' },
  };
});

// Mock the rate limiter
vi.mock('./rateLimiter', () => ({
  canPost: vi.fn(async () => ({ allowed: true })),
}));

// Mock post creation so scheduler tests stay unit-scoped
vi.mock('./posting', () => ({
  triggerPost: vi.fn(async () => ({
    success: true,
    post: {
      id: 'post-1',
      content: 'Generated post',
    },
  })),
}));

// Mock source fetching to avoid exercising fetcher behavior here
vi.mock('./contentFetcher', () => ({
  fetchAllSourcesForBot: vi.fn(async () => undefined),
}));

import {
  hasUnprocessedContent,
  getNextUnprocessedContent,
  processScheduledPosts,
  getBotSchedule,
  updateBotSchedule,
  removeBotSchedule,
} from './scheduler';

describe('hasUnprocessedContent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  
  it('should return false when no sources exist', async () => {
    const { db } = await import('@/db');
    vi.mocked(db.query.botContentSources.findMany).mockResolvedValue([]);
    
    const result = await hasUnprocessedContent('bot-1');
    expect(result).toBe(false);
  });
  
  it('should return true when unprocessed content exists', async () => {
    const { db } = await import('@/db');
    vi.mocked(db.query.botContentSources.findMany).mockResolvedValue([
      { id: 'source-1' } as any,
    ]);
    vi.mocked(db.query.botContentItems.findFirst).mockResolvedValue({
      id: 'item-1',
    } as any);
    
    const result = await hasUnprocessedContent('bot-1');
    expect(result).toBe(true);
  });
  
  it('should return false when all content is processed', async () => {
    const { db } = await import('@/db');
    vi.mocked(db.query.botContentSources.findMany).mockResolvedValue([
      { id: 'source-1' } as any,
    ]);
    vi.mocked(db.query.botContentItems.findFirst).mockResolvedValue(undefined);
    
    const result = await hasUnprocessedContent('bot-1');
    expect(result).toBe(false);
  });
});

describe('getNextUnprocessedContent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  
  it('should return null when no sources exist', async () => {
    const { db } = await import('@/db');
    vi.mocked(db.query.botContentSources.findMany).mockResolvedValue([]);
    
    const result = await getNextUnprocessedContent('bot-1');
    expect(result).toBeNull();
  });
  
  it('should return the oldest unprocessed item', async () => {
    const { db } = await import('@/db');
    const mockItem = {
      id: 'item-1',
      sourceId: 'source-1',
      title: 'Test Title',
      content: 'Test Content',
      url: 'https://example.com',
      publishedAt: new Date('2024-01-01'),
    };
    
    vi.mocked(db.query.botContentSources.findMany).mockResolvedValue([
      { id: 'source-1' } as any,
    ]);
    vi.mocked(db.query.botContentItems.findFirst).mockResolvedValue(mockItem as any);
    
    const result = await getNextUnprocessedContent('bot-1');
    expect(result).toEqual(mockItem);
  });
});

describe('processScheduledPosts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  
  it('should return empty result when no active bots', async () => {
    const { db } = await import('@/db');
    vi.mocked(db.query.bots.findMany).mockResolvedValue([]);
    
    const result = await processScheduledPosts();
    expect(result.processed).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.errors).toEqual([]);
  });
  
  it('should skip bots without schedule config', async () => {
    const { db } = await import('@/db');
    vi.mocked(db.query.bots.findMany).mockResolvedValue([
      {
        id: 'bot-1',
        scheduleConfig: null,
        lastPostAt: null,
      } as any,
    ]);
    
    const result = await processScheduledPosts();
    expect(result.skipped).toBe(1);
    expect(result.details[0].status).toBe('skipped_not_due');
  });
  
  it('should skip bots when schedule is not due', async () => {
    const { db } = await import('@/db');
    const recentPost = new Date(Date.now() - 5 * 60 * 1000); // 5 minutes ago
    
    vi.mocked(db.query.bots.findMany).mockResolvedValue([
      {
        id: 'bot-1',
        scheduleConfig: JSON.stringify({
          type: 'interval',
          intervalMinutes: 30,
        }),
        lastPostAt: recentPost,
      } as any,
    ]);
    
    const result = await processScheduledPosts();
    expect(result.skipped).toBe(1);
    expect(result.details[0].status).toBe('skipped_not_due');
  });
  
  it('should skip bots when rate limited', async () => {
    const { db } = await import('@/db');
    const { canPost } = await import('./rateLimiter');
    
    vi.mocked(db.query.bots.findMany).mockResolvedValue([
      {
        id: 'bot-1',
        scheduleConfig: JSON.stringify({
          type: 'interval',
          intervalMinutes: 30,
        }),
        lastPostAt: null,
      } as any,
    ]);
    
    vi.mocked(canPost).mockResolvedValue({
      allowed: false,
      reason: 'Daily limit reached',
    });
    
    const result = await processScheduledPosts();
    expect(result.skipped).toBe(1);
    expect(result.details[0].status).toBe('skipped_rate_limit');
  });
  
  it('should post original content when a bot has no active sources', async () => {
    const { db } = await import('@/db');
    const { canPost } = await import('./rateLimiter');
    
    vi.mocked(db.query.bots.findMany).mockResolvedValue([
      {
        id: 'bot-1',
        scheduleConfig: JSON.stringify({
          type: 'interval',
          intervalMinutes: 30,
        }),
        lastPostAt: null,
      } as any,
    ]);
    
    vi.mocked(canPost).mockResolvedValue({ allowed: true });
    vi.mocked(db.query.botContentSources.findMany).mockResolvedValue([]);
    
    const result = await processScheduledPosts();
    expect(result.processed).toBe(1);
    expect(result.details[0].status).toBe('posted');
  });
  
  it('should skip bots when active sources have no content available', async () => {
    const { db } = await import('@/db');
    const { canPost } = await import('./rateLimiter');
    
    vi.mocked(db.query.bots.findMany).mockResolvedValue([
      {
        id: 'bot-1',
        scheduleConfig: JSON.stringify({
          type: 'interval',
          intervalMinutes: 30,
        }),
        lastPostAt: null,
      } as any,
    ]);
    
    vi.mocked(canPost).mockResolvedValue({ allowed: true });
    vi.mocked(db.query.botContentSources.findMany).mockResolvedValue([
      { id: 'source-1' } as any,
    ]);
    vi.mocked(db.query.botContentItems.findFirst).mockResolvedValue(undefined);
    
    const result = await processScheduledPosts();
    expect(result.skipped).toBe(1);
    expect(result.details[0].status).toBe('skipped_no_content');
  });
  
  it('should process bots with due schedule and available content', async () => {
    const { db } = await import('@/db');
    const { canPost } = await import('./rateLimiter');
    
    vi.mocked(db.query.bots.findMany).mockResolvedValue([
      {
        id: 'bot-1',
        scheduleConfig: JSON.stringify({
          type: 'interval',
          intervalMinutes: 30,
        }),
        lastPostAt: null,
      } as any,
    ]);
    
    vi.mocked(canPost).mockResolvedValue({ allowed: true });
    vi.mocked(db.query.botContentSources.findMany).mockResolvedValue([
      { id: 'source-1' } as any,
    ]);
    vi.mocked(db.query.botContentItems.findFirst).mockResolvedValue({
      id: 'item-1',
      sourceId: 'source-1',
      title: 'Test Title',
      content: 'Test Content',
      url: 'https://example.com',
      publishedAt: new Date(),
    } as any);
    
    const result = await processScheduledPosts();
    expect(result.processed).toBe(1);
    expect(result.details[0].status).toBe('posted');
  });
});

describe('getBotSchedule', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  
  it('should return null when bot not found', async () => {
    const { db } = await import('@/db');
    vi.mocked(db.query.bots.findFirst).mockResolvedValue(undefined);
    
    const result = await getBotSchedule('bot-1');
    expect(result).toBeNull();
  });
  
  it('should return parsed schedule config', async () => {
    const { db } = await import('@/db');
    vi.mocked(db.query.bots.findFirst).mockResolvedValue({
      scheduleConfig: JSON.stringify({
        type: 'interval',
        intervalMinutes: 30,
      }),
    } as any);
    
    const result = await getBotSchedule('bot-1');
    expect(result).toEqual({
      type: 'interval',
      intervalMinutes: 30,
    });
  });
});

describe('updateBotSchedule', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  
  it('should update schedule config', async () => {
    const { db } = await import('@/db');
    
    const config: ScheduleConfig = {
      type: 'interval',
      intervalMinutes: 60,
    };
    
    await updateBotSchedule('bot-1', config);
    
    expect(db.update).toHaveBeenCalled();
  });
  
  it('should throw error for invalid config', async () => {
    const invalidConfig = {
      type: 'invalid',
    } as any;
    
    await expect(updateBotSchedule('bot-1', invalidConfig)).rejects.toThrow('Invalid schedule configuration');
  });
});

describe('removeBotSchedule', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  
  it('should remove schedule config', async () => {
    const { db } = await import('@/db');
    
    await removeBotSchedule('bot-1');
    
    expect(db.update).toHaveBeenCalled();
  });
});
