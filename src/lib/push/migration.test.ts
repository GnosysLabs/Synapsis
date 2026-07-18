import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Database } from '@tursodatabase/database';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('native push notification outbox migration', () => {
  let database: Database;

  beforeEach(async () => {
    database = new Database(':memory:');
    await database.connect();
    await database.exec('PRAGMA foreign_keys = ON');
    await database.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY NOT NULL);
      CREATE TABLE notifications (
        id TEXT PRIMARY KEY NOT NULL,
        user_id TEXT NOT NULL,
        type TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `);
    const migration = readFileSync(
      resolve('drizzle/20260718090000_native_ios_push/migration.sql'),
      'utf8',
    ).replaceAll('--> statement-breakpoint', '');
    await database.exec(migration);
    await database.run('INSERT INTO users (id) VALUES (?)', 'user-1');
    await database.run(
      `INSERT INTO push_subscriptions (
        id, user_id, installation_id, relay_subscription_id,
        relay_delivery_token_encrypted, environment, topic,
        follow_enabled, reply_enabled, mention_enabled, like_enabled, repost_enabled
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      'subscription-1',
      'user-1',
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
      'encrypted-token',
      'production',
      'xyz.gnosyslabs.synapsis',
      1,
      1,
      1,
      0,
      0,
    );
  });

  afterEach(async () => {
    await database.close();
  });

  it('automatically queues enabled notification types and skips disabled ones', async () => {
    await database.run(
      'INSERT INTO notifications (id, user_id, type) VALUES (?, ?, ?)',
      'notification-1',
      'user-1',
      'mention',
    );
    await database.run(
      'INSERT INTO notifications (id, user_id, type) VALUES (?, ?, ?)',
      'notification-2',
      'user-1',
      'like',
    );

    const deliveries = await database.all(
      'SELECT notification_id, subscription_id, status FROM push_deliveries ORDER BY notification_id',
    );
    expect(deliveries).toEqual([{
      notification_id: 'notification-1',
      subscription_id: 'subscription-1',
      status: 'pending',
    }]);
  });
});
