/**
 * Background Task Scheduler
 * 
 * Runs periodic tasks within the Next.js process:
 * - Swarm gossip (every 5 minutes)
 * - Remote follows sync (every 10 minutes)
 * - Swarm announcement (on startup)
 */

import { runGossipRound } from '@/lib/swarm/gossip';
import { announceToSeeds } from '@/lib/swarm/discovery';
import { getSwarmStats } from '@/lib/swarm/registry';
import { syncRemoteFollowsPosts } from '@/lib/background/remote-sync';
import { isPublicSwarmDomain } from '@/lib/swarm/node-domain';
import { processMentionDeliveryOutbox } from '@/lib/mentions/delivery';
import { processPushDeliveryOutbox } from '@/lib/push/delivery';
import { syncSwarmContentBatch } from '@/lib/swarm/content-cache';
import { markBackgroundStarted, markBackgroundTask } from '@/lib/background/health';
import { reconcilePostSearchIndex } from '@/lib/search/post-index';
import { processChangeNoticeCycle } from '@/lib/swarm/change-notice';

const GOSSIP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const REMOTE_SYNC_INTERVAL_MS = 60 * 1000; // 1 minute - keep feeds fresh
const MENTION_DELIVERY_INTERVAL_MS = 30 * 1000;
const PUSH_DELIVERY_INTERVAL_MS = 15 * 1000;
const CHANGE_NOTICE_INTERVAL_MS = 1_000;
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

async function runMentionDeliveries() {
  try {
    const result = await processMentionDeliveryOutbox();
    markBackgroundTask('mentions', { success: true });
    if (result.delivered > 0 || result.retried > 0 || result.dead > 0) {
      log('MENTIONS', `Delivered ${result.delivered}, retrying ${result.retried}, dead-lettered ${result.dead}`);
    }
  } catch (error) {
    markBackgroundTask('mentions', { success: false, error });
    log('MENTIONS', `Outbox error: ${error}`);
  }
}

async function runPushDeliveries() {
  try {
    const result = await processPushDeliveryOutbox();
    markBackgroundTask('push', { success: true });
    if (result.delivered > 0 || result.retried > 0 || result.dead > 0) {
      log('PUSH', `Delivered ${result.delivered}, retrying ${result.retried}, dead-lettered ${result.dead}`);
    }
  } catch (error) {
    markBackgroundTask('push', { success: false, error });
    log('PUSH', `Outbox error: ${error}`);
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
    markBackgroundTask('gossip', { success: true });
    if (result.contacted > 0) {
      log('SWARM', `Gossip: contacted ${result.contacted}, successful ${result.successful}, received ${result.totalNodesReceived} nodes`);
    } else if (stats.activeNodes === 0) {
      log('SWARM', 'No active swarm peers yet');
    }
  } catch (error) {
    markBackgroundTask('gossip', { success: false, error });
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
    markBackgroundTask('followSync', { success: true });
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
    markBackgroundTask('followSync', { success: false, error });
    log('REMOTE_SYNC', `Error: ${error}`);
  }
}

async function runSwarmContentSync() {
  try {
    const result = await syncSwarmContentBatch();
    await reconcilePostSearchIndex();
    const failures = result.domains.filter((domain) => domain.error);
    if (failures.length > 0) {
      const detail = failures
        .map((domain) => `${domain.domain}: ${domain.error}`)
        .join('; ');
      markBackgroundTask('contentSync', { success: false, error: detail });
      log('SWARM_CONTENT', `Peer failures: ${detail}`);
    } else {
      markBackgroundTask('contentSync', { success: true });
    }
    if (result.claimed > 0) {
      log('SWARM_CONTENT', `Synced ${result.synced}/${result.claimed} peers, cached ${result.cached} snapshots, failures ${result.failed}`);
    }
  } catch (error) {
    markBackgroundTask('contentSync', { success: false, error });
    log('SWARM_CONTENT', `Error: ${error}`);
  }
}

async function runChangeNotices() {
  try {
    const result = await processChangeNoticeCycle();
    markBackgroundTask('changeNotice', { success: true });
    if (result.originated || result.relayed > 0 || result.immediatePulls > 0 || result.pullFailures > 0) {
      log(
        'CHANGE_NOTICE',
        `Originated ${result.originated ? 1 : 0}, relayed ${result.relayed} cursors to ${result.relayTargets} peers, immediate pulls ${result.immediatePulls}, failures ${result.pullFailures}`,
      );
    }
  } catch (error) {
    markBackgroundTask('changeNotice', { success: false, error });
    log('CHANGE_NOTICE', `Error: ${error}`);
  }
}

export function startBackgroundTasks(origin?: string) {
  // Prevent double-start (Next.js can call register() multiple times in dev)
  if (isStarted) return;
  isStarted = true;
  markBackgroundStarted();

  // Default origin for remote sync (can be overridden)
  const syncOrigin = origin || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:43821';
  const publicSwarmEnabled = isPublicSwarmDomain(process.env.NEXT_PUBLIC_NODE_DOMAIN);

  log('STARTUP', 'Background task scheduler starting...');
  log('STARTUP', `Gossip interval: ${GOSSIP_INTERVAL_MS / 1000}s, Remote sync interval: ${REMOTE_SYNC_INTERVAL_MS / 1000}s`);
  log('STARTUP', `ChangeNoticeV1: ${publicSwarmEnabled ? 'active' : 'disabled for non-public node'}`);

  // Wait for server to be fully ready before starting tasks
  setTimeout(async () => {
    log('STARTUP', 'Starting background tasks...');
    
    if (publicSwarmEnabled) {
      // Announce to swarm on startup
      await announceToSwarm();
    } else {
      log('SWARM', 'Public swarm disabled: NEXT_PUBLIC_NODE_DOMAIN is not a public ICANN domain');
    }
    
    await runMentionDeliveries();
    await runPushDeliveries();
    
    // Run initial remote sync (after 15s to let server stabilize)
    setTimeout(() => runRemoteSync(syncOrigin), 15 * 1000);
    if (publicSwarmEnabled) {
      setTimeout(runSwarmContentSync, 20 * 1000);
      setTimeout(runChangeNotices, 5 * 1000);
    }
    
    // Schedule recurring tasks
    setInterval(runMentionDeliveries, MENTION_DELIVERY_INTERVAL_MS);
    setInterval(runPushDeliveries, PUSH_DELIVERY_INTERVAL_MS);
    if (publicSwarmEnabled) {
      setInterval(runSwarmGossip, GOSSIP_INTERVAL_MS);
      setInterval(runSwarmContentSync, REMOTE_SYNC_INTERVAL_MS);
      setInterval(runChangeNotices, CHANGE_NOTICE_INTERVAL_MS);
    }
    setInterval(() => runRemoteSync(syncOrigin), REMOTE_SYNC_INTERVAL_MS);
    
    // First gossip after 30s (let announcement propagate)
    if (publicSwarmEnabled) {
      setTimeout(runSwarmGossip, 30 * 1000);
    }
    
    log('STARTUP', 'Background tasks running');
  }, STARTUP_DELAY_MS);
}
