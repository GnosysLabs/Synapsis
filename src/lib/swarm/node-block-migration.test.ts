import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Database } from '@tursodatabase/database';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('node-block relationship quarantine migration', () => {
  let client: Database;

  beforeEach(async () => {
    client = new Database(':memory:');
    await client.connect();
    await client.exec(`
      PRAGMA foreign_keys = OFF;
      CREATE TABLE swarm_nodes (
        id text PRIMARY KEY, domain text NOT NULL UNIQUE,
        is_blocked integer DEFAULT 0 NOT NULL, blocked_at integer
      );
      CREATE TABLE users (
        id text PRIMARY KEY, home_domain text NOT NULL, is_local_account integer NOT NULL,
        display_name text, bio text, avatar_url text, header_url text, website text,
        followers_count integer DEFAULT 0 NOT NULL,
        following_count integer DEFAULT 0 NOT NULL,
        posts_count integer DEFAULT 0 NOT NULL
      );
      CREATE TABLE follows (follower_id text NOT NULL, following_id text NOT NULL);
      CREATE TABLE remote_follows (
        id text PRIMARY KEY, follower_id text NOT NULL, target_handle text NOT NULL,
        target_actor_url text NOT NULL, inbox_url text NOT NULL, activity_id text NOT NULL,
        display_name text, bio text, avatar_url text,
        created_at integer DEFAULT (unixepoch()) NOT NULL
      );
      CREATE TABLE remote_followers (
        id text PRIMARY KEY, user_id text NOT NULL, actor_url text NOT NULL,
        inbox_url text NOT NULL, shared_inbox_url text, handle text, activity_id text,
        created_at integer DEFAULT (unixepoch()) NOT NULL
      );
      CREATE TABLE posts (id text PRIMARY KEY, user_id text NOT NULL, swarm_reply_to_id text);
      CREATE TABLE remote_likes (id text PRIMARY KEY, actor_node_domain text NOT NULL);
      CREATE TABLE remote_reposts (id text PRIMARY KEY, actor_node_domain text NOT NULL);
      CREATE TABLE notifications (
        id text PRIMARY KEY, actor_node_domain text NOT NULL, remote_post_domain text
      );
      CREATE TABLE mention_deliveries (
        id text PRIMARY KEY, target_domain text NOT NULL, status text NOT NULL
      );
      CREATE TABLE chat_messages (id text PRIMARY KEY, sender_node_domain text NOT NULL);
      CREATE TABLE remote_posts (id text PRIMARY KEY, node_domain text);
      CREATE TABLE remote_feed_stories (
        node_domain text NOT NULL, original_post_id text NOT NULL,
        PRIMARY KEY (node_domain, original_post_id)
      );
      CREATE TABLE user_swarm_likes (id text PRIMARY KEY, node_domain text NOT NULL);
      CREATE TABLE user_swarm_reposts (
        id text PRIMARY KEY, node_domain text NOT NULL, content text NOT NULL,
        author_display_name text, author_avatar_url text,
        likes_count integer DEFAULT 0 NOT NULL, reposts_count integer DEFAULT 0 NOT NULL,
        replies_count integer DEFAULT 0 NOT NULL, link_preview_url text,
        link_preview_title text, link_preview_description text, link_preview_image text,
        link_preview_type text, link_preview_video_url text,
        link_preview_media_json text, media_json text
      );
      CREATE TABLE swarm_change_notice_states (
        origin_domain text PRIMARY KEY, status text NOT NULL
      );
      CREATE TABLE swarm_change_bundles (origin_domain text NOT NULL);
      CREATE TABLE swarm_content_sync_states (domain text PRIMARY KEY);
      CREATE TABLE remote_follow_sync_states (
        target_handle text PRIMARY KEY, node_domain text NOT NULL
      );

      INSERT INTO swarm_nodes (id, domain, is_blocked, blocked_at) VALUES
        ('blocked', 'remote.social', 1, 1_750_000_000),
        ('allowed', 'allowed.social', 0, NULL);
      INSERT INTO users (id, home_domain, is_local_account, followers_count, following_count)
        VALUES ('local', 'local.social', 1, 2, 2);
      INSERT INTO remote_follows
        (id, follower_id, target_handle, target_actor_url, inbox_url, activity_id) VALUES
        ('blocked-out', 'local', 'alice@remote.social', 'swarm://remote.social/alice', 'inbox', 'a1'),
        ('allowed-out', 'local', 'bob@allowed.social', 'swarm://allowed.social/bob', 'inbox', 'a2');
      INSERT INTO remote_followers
        (id, user_id, actor_url, inbox_url, handle, activity_id) VALUES
        ('blocked-in', 'local', 'swarm://remote.social/alice', 'inbox', NULL, 'a3'),
        ('allowed-in', 'local', 'swarm://allowed.social/bob', 'inbox', 'bob@allowed.social', 'a4');
    `);
  });

  afterEach(async () => {
    await client.close();
  });

  it('backfills canonical domains, suspends blocked edges, repairs counts, and closes races', async () => {
    const migration = readFileSync(
      resolve('drizzle/20260721002000_node_block_quarantine/migration.sql'),
      'utf8',
    ).replaceAll('--> statement-breakpoint', '');
    await client.exec(migration);

    expect(await client.all(`
      SELECT id, target_node_domain AS domain, suspended_at IS NOT NULL AS suspended
      FROM remote_follows ORDER BY id
    `)).toEqual([
      { id: 'allowed-out', domain: 'allowed.social', suspended: 0 },
      { id: 'blocked-out', domain: 'remote.social', suspended: 1 },
    ]);
    expect(await client.all(`
      SELECT id, actor_node_domain AS domain, suspended_at IS NOT NULL AS suspended
      FROM remote_followers ORDER BY id
    `)).toEqual([
      { id: 'allowed-in', domain: 'allowed.social', suspended: 0 },
      { id: 'blocked-in', domain: 'remote.social', suspended: 1 },
    ]);
    expect(await client.all(`
      SELECT followers_count AS followers, following_count AS following
      FROM users WHERE id = 'local'
    `)).toEqual([{ followers: 1, following: 1 }]);

    await expect(client.exec(`
      INSERT INTO remote_follows (
        id, follower_id, target_handle, target_node_domain,
        target_actor_url, inbox_url, activity_id
      ) VALUES (
        'late', 'local', 'late@remote.social', 'remote.social',
        'swarm://remote.social/late', 'inbox', 'late'
      )
    `)).rejects.toThrow('cannot activate a follow for a blocked node');
  });
});
