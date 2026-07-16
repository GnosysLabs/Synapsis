/**
 * Next.js Instrumentation
 * 
 * This file runs when the Next.js server starts.
 * We use it to initialize background tasks like:
 * - Swarm announcement (on startup)
 * - Swarm gossip (every 5 minutes)
 * 
 * This eliminates the need for a separate cron process.
 */

export async function register() {
  // Only run on the server (not during build or in edge runtime)
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startBackgroundTasks } = await import('@/lib/background/scheduler');
    startBackgroundTasks();
  }
}
