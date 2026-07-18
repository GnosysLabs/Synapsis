import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Database } from '@tursodatabase/database';

export type ApnsEnvironment = 'sandbox' | 'production';

export interface SubscriptionRow {
  id: string;
  installation_id: string;
  device_token_encrypted: string;
  environment: ApnsEnvironment;
  topic: string;
  node_origin: string;
  app_version: string;
  delivery_token_hash: string;
  management_token_hash: string;
  disabled_at: number | null;
  created_at: number;
  updated_at: number;
}

export type DeliveryClaim = 'claimed' | 'delivered' | 'busy';

export class PushRelayDatabase {
  private readonly client: Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.client = new Database(path);
  }

  async connect(): Promise<void> {
    await this.client.connect();
    await this.client.exec('PRAGMA foreign_keys = ON');
    await this.client.exec('PRAGMA journal_mode = WAL');
    await this.client.exec(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        id TEXT PRIMARY KEY NOT NULL,
        installation_id TEXT NOT NULL,
        device_token_encrypted TEXT NOT NULL,
        environment TEXT NOT NULL CHECK (environment IN ('sandbox', 'production')),
        topic TEXT NOT NULL CHECK (topic = 'xyz.gnosyslabs.synapsis'),
        node_origin TEXT NOT NULL,
        app_version TEXT NOT NULL,
        delivery_token_hash TEXT NOT NULL,
        management_token_hash TEXT NOT NULL,
        disabled_at INTEGER,
        created_at INTEGER DEFAULT (unixepoch()) NOT NULL,
        updated_at INTEGER DEFAULT (unixepoch()) NOT NULL
      );
      CREATE INDEX IF NOT EXISTS subscriptions_installation_idx
        ON subscriptions (installation_id);
      CREATE INDEX IF NOT EXISTS subscriptions_active_idx
        ON subscriptions (disabled_at);
      CREATE TABLE IF NOT EXISTS deliveries (
        subscription_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        notification_type TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('processing', 'delivered', 'failed')),
        apns_id TEXT,
        error TEXT,
        created_at INTEGER DEFAULT (unixepoch()) NOT NULL,
        updated_at INTEGER DEFAULT (unixepoch()) NOT NULL,
        PRIMARY KEY (subscription_id, event_id),
        FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS deliveries_rate_idx
        ON deliveries (subscription_id, created_at);
    `);
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  async createSubscription(input: Omit<SubscriptionRow, 'disabled_at' | 'created_at' | 'updated_at'>): Promise<void> {
    await this.client.run(
      `INSERT INTO subscriptions (
        id, installation_id, device_token_encrypted, environment, topic,
        node_origin, app_version, delivery_token_hash, management_token_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.id,
      input.installation_id,
      input.device_token_encrypted,
      input.environment,
      input.topic,
      input.node_origin,
      input.app_version,
      input.delivery_token_hash,
      input.management_token_hash,
    );
  }

  async getSubscription(id: string): Promise<SubscriptionRow | undefined> {
    return await this.client.get('SELECT * FROM subscriptions WHERE id = ? LIMIT 1', id) as SubscriptionRow | undefined;
  }

  async updateSubscription(
    id: string,
    input: Pick<SubscriptionRow,
      'installation_id' | 'device_token_encrypted' | 'environment' | 'topic' |
      'node_origin' | 'app_version' | 'delivery_token_hash' | 'management_token_hash'>,
  ): Promise<void> {
    await this.client.run(
      `UPDATE subscriptions SET
        installation_id = ?, device_token_encrypted = ?, environment = ?, topic = ?,
        node_origin = ?, app_version = ?, delivery_token_hash = ?, management_token_hash = ?,
        disabled_at = NULL, updated_at = unixepoch()
       WHERE id = ?`,
      input.installation_id,
      input.device_token_encrypted,
      input.environment,
      input.topic,
      input.node_origin,
      input.app_version,
      input.delivery_token_hash,
      input.management_token_hash,
      id,
    );
  }

  async disableSubscription(id: string): Promise<void> {
    await this.client.run(
      'UPDATE subscriptions SET disabled_at = unixepoch(), updated_at = unixepoch() WHERE id = ?',
      id,
    );
  }

  async deleteSubscription(id: string): Promise<void> {
    await this.client.run('DELETE FROM subscriptions WHERE id = ?', id);
  }

  async recentDeliveryCount(subscriptionId: string, since: number): Promise<number> {
    const row = await this.client.get(
      'SELECT COUNT(*) AS count FROM deliveries WHERE subscription_id = ? AND created_at >= ?',
      subscriptionId,
      since,
    ) as { count?: number | bigint } | undefined;
    return Number(row?.count || 0);
  }

  async claimDelivery(subscriptionId: string, eventId: string, type: string): Promise<DeliveryClaim> {
    const existing = await this.client.get(
      `SELECT status, updated_at FROM deliveries
       WHERE subscription_id = ? AND event_id = ? LIMIT 1`,
      subscriptionId,
      eventId,
    ) as { status: string; updated_at: number } | undefined;

    if (existing?.status === 'delivered') return 'delivered';
    if (existing?.status === 'processing' && existing.updated_at >= Math.floor(Date.now() / 1000) - 120) {
      return 'busy';
    }
    if (existing) {
      await this.client.run(
        `UPDATE deliveries SET status = 'processing', notification_type = ?, error = NULL,
         updated_at = unixepoch() WHERE subscription_id = ? AND event_id = ?`,
        type,
        subscriptionId,
        eventId,
      );
      return 'claimed';
    }

    await this.client.run(
      `INSERT INTO deliveries (subscription_id, event_id, notification_type, status)
       VALUES (?, ?, ?, 'processing')`,
      subscriptionId,
      eventId,
      type,
    );
    return 'claimed';
  }

  async finishDelivery(
    subscriptionId: string,
    eventId: string,
    status: 'delivered' | 'failed',
    apnsId?: string,
    error?: string,
  ): Promise<void> {
    await this.client.run(
      `UPDATE deliveries SET status = ?, apns_id = ?, error = ?, updated_at = unixepoch()
       WHERE subscription_id = ? AND event_id = ?`,
      status,
      apnsId || null,
      error?.slice(0, 500) || null,
      subscriptionId,
      eventId,
    );
  }
}
