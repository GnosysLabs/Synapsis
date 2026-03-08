/**
 * Background Task Scheduler
 * 
 * Runs periodic tasks within the Next.js process:
 * - Bot autonomous posting (every 1 minute)
 * - Swarm gossip (every 5 minutes)
 * - Remote follows sync (every 10 minutes)
 * - Swarm announcement (on startup)
 */

import { processAllAutonomousBots } from '@/lib/bots/autonomous';
import { runGossipRound } from '@/lib/swarm/gossip';
import { announceToSeeds } from '@/lib/swarm/discovery';
import { getSwarmStats } from '@/lib/swarm/registry';
import { syncRemoteFollowsPosts } from '@/lib/background/remote-sync';

const BOT_INTERVAL_MS = 60 * 1000; // 1 minute
const GOSSIP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const REMOTE_SYNC_INTERVAL_MS = 60 * 1000; // 1 minute - keep feeds fresh
const STARTUP_DELAY_MS = 10 * 1000; // Wait 10s for server to be ready

let isStarted = false;

function log(category: string, message: string, data?: unknown) {
  const timestamp = new Date().toISOString();
  if (data) {
    console.log(`[${timestamp}] [${category}] ${message}`, JSON.stringify(data, null, 2));
  } else {
    console.log(`[${timestamp}] [${category}] ${message}`);
  }
}

async function runBotTasks() {
  try {
    const results = await processAllAutonomousBots();
    
    const posted = results.filter(r => r.result.posted).length;
    const errors = results.filter(r => r.error).length;
    
    if (posted > 0) {
      log('BOTS', `Created ${posted} posts`);
    } else if (results.length > 0) {
      // Log why bots didn't post
      const reasons = results
        .filter(r => !r.result.posted)
        .map(r => `${r.botHandle}: ${r.result.reason || r.error || 'unknown'}`)
        .slice(0, 5);
      
      if (reasons.length > 0) {
        log('BOTS', `${results.length} bots checked, no posts. Reasons: ${reasons.join('; ')}`);
      }
    } else {
      log('BOTS', 'No active bots found');
    }
    
    if (errors > 0) {
      const errorMsgs = results.filter(r => r.error).map(r => `${r.botHandle}: ${r.error}`);
      log('BOTS', `Errors: ${errorMsgs.join('; ')}`);
    }
  } catch (error) {
    log('BOTS', `Error: ${error}`);
  }
}

async function runSwarmGossip() {
  try {
    const stats = await getSwarmStats();

    // Recover from empty peer lists by periodically re-announcing to seeds.
    if (stats.activeNodes === 0) {
      const announceResult = await announceToSeeds();
      if (announceResult.successful.length > 0 || announceResult.failed.length > 0) {
        log('SWARM', `Re-announced to seeds: ${announceResult.successful.length} successful, ${announceResult.failed.length} failed`);
      }
    }

    const result = await runGossipRound();
    if (result.contacted > 0) {
      log('SWARM', `Gossip: contacted ${result.contacted}, successful ${result.successful}, received ${result.totalNodesReceived} nodes`);
    } else if (stats.activeNodes === 0) {
      log('SWARM', 'No active swarm peers yet');
    }
  } catch (error) {
    log('SWARM', `Gossip error: ${error}`);
  }
}

async function announceToSwarm() {
  try {
    const result = await announceToSeeds();
    log('SWARM', `Announced to seeds: ${result.successful.length} successful, ${result.failed.length} failed`);
    
    const stats = await getSwarmStats();
    log('SWARM', `Network: ${stats.activeNodes} active nodes, ${stats.totalUsers} users, ${stats.totalPosts} posts`);
  } catch (error) {
    log('SWARM', `Announcement error: ${error}`);
  }
}

async function runRemoteSync(origin: string) {
  try {
    const result = await syncRemoteFollowsPosts(origin);
    if (result.synced > 0 || result.errors > 0) {
      log('REMOTE_SYNC', `Synced ${result.synced} users, skipped ${result.skipped}, errors ${result.errors}`);
      if (result.details.length > 0) {
        const newPosts = result.details.filter(d => d.cached > 0);
        if (newPosts.length > 0) {
          log('REMOTE_SYNC', `New posts: ${newPosts.map(d => `${d.handle}: ${d.cached}`).join(', ')}`);
        }
      }
    }
  } catch (error) {
    log('REMOTE_SYNC', `Error: ${error}`);
  }
}

export function startBackgroundTasks(origin?: string) {
  // Prevent double-start (Next.js can call register() multiple times in dev)
  if (isStarted) return;
  isStarted = true;

  // Default origin for remote sync (can be overridden)
  const syncOrigin = origin || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

  log('STARTUP', 'Background task scheduler starting...');
  log('STARTUP', `Bot interval: ${BOT_INTERVAL_MS / 1000}s, Gossip interval: ${GOSSIP_INTERVAL_MS / 1000}s, Remote sync interval: ${REMOTE_SYNC_INTERVAL_MS / 1000}s`);

  // Wait for server to be fully ready before starting tasks
  setTimeout(async () => {
    log('STARTUP', 'Starting background tasks...');
    
    // Announce to swarm on startup
    await announceToSwarm();
    
    // Run initial bot check
    await runBotTasks();
    
    // Run initial remote sync (after 15s to let server stabilize)
    setTimeout(() => runRemoteSync(syncOrigin), 15 * 1000);
    
    // Schedule recurring tasks
    setInterval(runBotTasks, BOT_INTERVAL_MS);
    setInterval(runSwarmGossip, GOSSIP_INTERVAL_MS);
    setInterval(() => runRemoteSync(syncOrigin), REMOTE_SYNC_INTERVAL_MS);
    
    // First gossip after 30s (let announcement propagate)
    setTimeout(runSwarmGossip, 30 * 1000);
    
    log('STARTUP', 'Background tasks running');
  }, STARTUP_DELAY_MS);
}
