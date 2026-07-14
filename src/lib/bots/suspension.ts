/**
 * Bot Suspension Service
 * 
 * Handles bot suspension and reinstatement.
 * Suspended bots cannot perform any actions.
 * 
 * Requirements: 10.6
 */

import { db, bots } from '@/db';
import { eq } from 'drizzle-orm';

// ============================================
// SUSPENSION FUNCTIONS
// ============================================

/**
 * Suspend a bot.
 * 
 * @param botId - The ID of the bot to suspend
 * @param reason - Reason for suspension
 * @returns Updated bot
 * 
 * Validates: Requirements 10.6
 */
export async function suspendBot(botId: string, reason: string) {
  const [bot] = await db.update(bots)
    .set({
      isSuspended: true,
      suspensionReason: reason,
      suspendedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(bots.id, botId))
    .returning();
  
  return bot;
}

/**
 * Reinstate a suspended bot.
 * 
 * @param botId - The ID of the bot to reinstate
 * @returns Updated bot
 * 
 * Validates: Requirements 10.6
 */
export async function reinstateBot(botId: string) {
  const [bot] = await db.update(bots)
    .set({
      isSuspended: false,
      suspensionReason: null,
      suspendedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(bots.id, botId))
    .returning();
  
  return bot;
}

/**
 * Check if a bot is suspended.
 * 
 * @param botId - The ID of the bot
 * @returns True if suspended
 * 
 * Validates: Requirements 10.6
 */
export async function isBotSuspended(botId: string): Promise<boolean> {
  const bot = await db.query.bots.findFirst({
    where: { id: botId },
    columns: { isSuspended: true },
  });
  
  return bot?.isSuspended || false;
}

/**
 * Throw error if bot is suspended.
 * 
 * @param botId - The ID of the bot
 * @throws Error if bot is suspended
 * 
 * Validates: Requirements 10.6
 */
export async function ensureBotNotSuspended(botId: string): Promise<void> {
  const bot = await db.query.bots.findFirst({
    where: { id: botId },
    columns: { isSuspended: true, suspensionReason: true },
  });
  
  if (bot?.isSuspended) {
    throw new Error(`Bot is suspended: ${bot.suspensionReason || 'No reason provided'}`);
  }
}
