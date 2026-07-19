import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '@tursodatabase/database';
import { drizzle } from 'drizzle-orm/tursodatabase/database';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { relations } from '@/db/relations';
import type { db as productionDatabase } from '@/db';
import { applyRemoteAccountDeletions } from './content-cache';

function testDatabase(client: Database) {
  return drizzle({ client, relations });
}

describe('remote account deletion convergence', () => {
  let directory: string;
  let client: Database;
  let database: ReturnType<typeof testDatabase>;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'synapsis-account-delete-'));
    client = new Database(join(directory, 'test.db'));
    await client.connect();
    database = testDatabase(client);
    await client.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE users (
        id text PRIMARY KEY, did text NOT NULL UNIQUE, handle text NOT NULL UNIQUE,
        public_key text NOT NULL, followers_count integer DEFAULT 0 NOT NULL,
        following_count integer DEFAULT 0 NOT NULL, posts_count integer DEFAULT 0 NOT NULL
      );
      CREATE TABLE posts (
        id text PRIMARY KEY, user_id text NOT NULL, likes_count integer DEFAULT 0 NOT NULL,
        reposts_count integer DEFAULT 0 NOT NULL, replies_count integer DEFAULT 0 NOT NULL,
        reply_to_id text
      );
      CREATE TABLE handle_registry (
        handle text PRIMARY KEY, did text NOT NULL, node_domain text NOT NULL,
        identity_verified integer DEFAULT 0 NOT NULL, deleted_at integer,
        registered_at integer DEFAULT (unixepoch()) NOT NULL,
        updated_at integer DEFAULT (unixepoch()) NOT NULL
      );
      CREATE UNIQUE INDEX handle_registry_verified_node_did_unique_idx
        ON handle_registry (node_domain, did) WHERE identity_verified = 1;
      CREATE TABLE remote_follows (
        id text PRIMARY KEY, follower_id text NOT NULL, target_handle text NOT NULL,
        target_actor_url text NOT NULL, inbox_url text NOT NULL, activity_id text NOT NULL
      );
      CREATE TABLE remote_followers (
        id text PRIMARY KEY, user_id text NOT NULL, actor_url text NOT NULL,
        inbox_url text NOT NULL, handle text
      );
      CREATE TABLE remote_likes (
        id text PRIMARY KEY, post_id text NOT NULL, actor_handle text NOT NULL,
        actor_node_domain text NOT NULL
      );
      CREATE TABLE remote_reposts (
        id text PRIMARY KEY, post_id text NOT NULL, actor_handle text NOT NULL,
        actor_node_domain text NOT NULL
      );
      CREATE TABLE remote_posts (
        id text PRIMARY KEY, node_domain text, author_handle text NOT NULL
      );
      CREATE TABLE user_swarm_likes (
        id text PRIMARY KEY, user_id text NOT NULL, node_domain text NOT NULL,
        original_post_id text NOT NULL, author_handle text NOT NULL
      );
      CREATE TABLE user_swarm_reposts (
        id text PRIMARY KEY, user_id text NOT NULL, node_domain text NOT NULL,
        original_post_id text NOT NULL, author_handle text NOT NULL
      );
      CREATE TABLE notifications (
        id text PRIMARY KEY, user_id text NOT NULL, actor_handle text NOT NULL,
        actor_node_domain text
      );
      CREATE TABLE e2ee_remote_key_bundles (
        did text PRIMARY KEY, handle text NOT NULL, key_id text NOT NULL,
        key_version integer NOT NULL, public_key text NOT NULL, proof_action text NOT NULL,
        signing_public_key text NOT NULL
      );
      CREATE TABLE swarm_relationship_states (
        id text PRIMARY KEY, source_domain text NOT NULL, actor_did text NOT NULL
      );
    `);
  });

  afterEach(async () => {
    await client.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('removes every cached projection and corrects denormalized counters', async () => {
    await client.exec(`
      INSERT INTO users (id, did, handle, public_key, followers_count, following_count, posts_count)
        VALUES ('local', 'did:key:local', 'local', 'key', 1, 1, 1),
               ('remote', 'did:key:alice', 'alice@remote.social', 'key', 0, 0, 0);
      INSERT INTO posts (id, user_id, likes_count, reposts_count, replies_count, reply_to_id)
        VALUES ('post', 'local', 1, 1, 1, NULL),
               ('remote-reply', 'remote', 0, 0, 0, 'post');
      INSERT INTO handle_registry (handle, did, node_domain, identity_verified)
        VALUES ('alice@remote.social', 'did:key:alice', 'remote.social', 1);
      INSERT INTO remote_follows VALUES
        ('out', 'local', 'alice@remote.social', 'swarm://remote.social/alice', 'inbox', 'activity');
      INSERT INTO remote_followers (id, user_id, actor_url, inbox_url, handle) VALUES
        ('in', 'local', 'swarm://remote.social/alice', 'inbox', 'alice@remote.social');
      INSERT INTO remote_likes VALUES ('like', 'post', 'alice', 'remote.social');
      INSERT INTO remote_reposts VALUES ('repost', 'post', 'alice', 'remote.social');
      INSERT INTO remote_posts VALUES ('cached-post', 'remote.social', 'alice@remote.social');
      INSERT INTO user_swarm_likes VALUES
        ('saved-like', 'local', 'remote.social', 'remote-post', 'alice@remote.social');
      INSERT INTO user_swarm_reposts VALUES
        ('saved-repost', 'local', 'remote.social', 'remote-post', 'alice@remote.social');
      INSERT INTO notifications VALUES ('notification', 'local', 'alice', 'remote.social');
      INSERT INTO e2ee_remote_key_bundles
        (did, handle, key_id, key_version, public_key, proof_action, signing_public_key)
        VALUES ('did:key:alice', 'alice@remote.social', 'key-id', 1, 'key', '{}', 'signing');
      INSERT INTO swarm_relationship_states VALUES
        ('state', 'remote.social', 'did:key:alice');
    `);

    await expect(applyRemoteAccountDeletions('remote.social', [{
      sequence: 7,
      handle: 'alice',
      did: 'did:key:alice',
      deletedAt: '2026-07-18T12:00:00.000Z',
    }], database as unknown as typeof productionDatabase)).resolves.toBe(1);

    expect(await client.all(`
      SELECT followers_count AS followers, following_count AS following, posts_count AS posts
      FROM users WHERE id = 'local'
    `)).toEqual([{ followers: 0, following: 0, posts: 0 }]);
    expect(await client.all(`
      SELECT likes_count AS likes, reposts_count AS reposts, replies_count AS replies
      FROM posts WHERE id = 'post'
    `)).toEqual([{ likes: 0, reposts: 0, replies: 0 }]);
    expect(await client.all(`SELECT id FROM posts WHERE id = 'remote-reply'`)).toEqual([]);
    for (const [table, key] of [
      ['remote_follows', 'id'], ['remote_followers', 'id'], ['remote_likes', 'id'],
      ['remote_reposts', 'id'], ['remote_posts', 'id'], ['user_swarm_likes', 'id'],
      ['user_swarm_reposts', 'id'], ['notifications', 'id'],
      ['e2ee_remote_key_bundles', 'did'], ['swarm_relationship_states', 'id'],
    ]) {
      expect(await client.all(`SELECT ${key} FROM ${table}`)).toEqual([]);
    }
    expect(await client.all(`SELECT id FROM users WHERE id = 'remote'`)).toEqual([]);
    expect(await client.all(`
      SELECT did, deleted_at AS deletedAt FROM handle_registry
      WHERE handle = 'alice@remote.social'
    `)).toEqual([{ did: 'did:key:alice', deletedAt: 1784376000 }]);
  });

  it('rejects a node tombstone that conflicts with an already verified DID', async () => {
    await client.exec(`
      INSERT INTO handle_registry (handle, did, node_domain, identity_verified)
        VALUES ('alice@remote.social', 'did:key:real-alice', 'remote.social', 1);
    `);
    await expect(applyRemoteAccountDeletions('remote.social', [{
      sequence: 8,
      handle: 'alice',
      did: 'did:key:forged-alice',
      deletedAt: '2026-07-18T12:00:00.000Z',
    }], database as unknown as typeof productionDatabase)).resolves.toBe(0);
    expect(await client.all(`
      SELECT did, deleted_at AS deletedAt FROM handle_registry
    `)).toEqual([{ did: 'did:key:real-alice', deletedAt: null }]);
  });
});
