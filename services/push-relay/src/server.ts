import crypto from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { z } from 'zod';

import { ApplePushNotificationService, type ApnsSender, type PushEvent } from './apns';
import { loadConfiguration, SYNAPSIS_IOS_TOPIC, type PushRelayConfiguration } from './config';
import { PushRelayDatabase, type SubscriptionRow } from './database';
import {
  generateBearerToken,
  openDeviceToken,
  sealDeviceToken,
  tokenHash,
  tokenMatches,
} from './crypto';

const registrationSchema = z.object({
  installationId: z.uuid(),
  apnsToken: z.string().min(32).max(512).regex(/^[a-fA-F0-9]+$/),
  environment: z.enum(['sandbox', 'production']),
  topic: z.literal(SYNAPSIS_IOS_TOPIC),
  nodeOrigin: z.url().max(2048),
  appVersion: z.string().min(1).max(64),
}).strict();

const avatarURLSchema = z.url().max(2048).refine((value) => {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password;
}, 'Avatar URL must be a credential-free HTTPS URL');

const notificationEventSchema = z.object({
  eventId: z.uuid(),
  notificationId: z.uuid(),
  type: z.enum(['follow', 'reply', 'mention', 'like', 'repost']),
  actorName: z.string().min(1).max(160),
  actorAvatarUrl: avatarURLSchema.optional(),
  badge: z.number().int().min(0).max(999_999).optional(),
  postId: z.string().min(1).max(256).optional(),
}).strict();

const messageEventSchema = z.object({
  eventId: z.uuid(),
  messageId: z.string().min(1).max(256),
  type: z.literal('message'),
  actorName: z.string().min(1).max(160),
  actorAvatarUrl: avatarURLSchema.optional(),
  badge: z.number().int().min(0).max(999_999).optional(),
}).strict();

const eventSchema = z.discriminatedUnion('type', [
  notificationEventSchema,
  messageEventSchema,
]);

type Registration = z.infer<typeof registrationSchema>;

interface RelayDependencies {
  config: PushRelayConfiguration;
  database: PushRelayDatabase;
  apns: ApnsSender;
}

interface RateEntry { count: number; resetAt: number }
const registrationRates = new Map<string, RateEntry>();

function respond(response: ServerResponse, status: number, payload?: unknown): void {
  response.statusCode = status;
  response.setHeader('cache-control', 'no-store');
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(payload === undefined ? undefined : JSON.stringify(payload));
}

function bearerToken(request: IncomingMessage): string | undefined {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith('Bearer ')) return undefined;
  return authorization.slice('Bearer '.length).trim();
}

async function jsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 16 * 1024) throw new Error('Request body is too large');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function normalizedNodeOrigin(value: string): string {
  const url = new URL(value);
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(process.env.NODE_ENV !== 'production' && local)) {
    throw new Error('nodeOrigin must use HTTPS');
  }
  if (url.username || url.password) throw new Error('nodeOrigin must not contain credentials');
  return url.origin;
}

function registrationAllowed(address: string): boolean {
  const now = Date.now();
  const entry = registrationRates.get(address);
  if (!entry || entry.resetAt <= now) {
    registrationRates.set(address, { count: 1, resetAt: now + 10 * 60 * 1000 });
    return true;
  }
  entry.count += 1;
  return entry.count <= 30;
}

function clientAddress(request: IncomingMessage): string {
  const connectingIP = request.headers['cf-connecting-ip'];
  const value = Array.isArray(connectingIP) ? connectingIP[0] : connectingIP;
  if (value && isIP(value.trim())) return value.trim();
  return request.socket.remoteAddress || 'unknown';
}

async function authenticate(
  database: PushRelayDatabase,
  subscriptionId: string,
  provided: string | undefined,
  kind: 'management' | 'delivery',
): Promise<SubscriptionRow | undefined> {
  if (!provided) return undefined;
  const subscription = await database.getSubscription(subscriptionId);
  if (!subscription || subscription.disabled_at) return undefined;
  const expected = kind === 'management'
    ? subscription.management_token_hash
    : subscription.delivery_token_hash;
  return tokenMatches(provided, expected) ? subscription : undefined;
}

function subscriptionCredentials(subscriptionId: string, deliveryToken: string, managementToken: string) {
  return { subscriptionId, deliveryToken, managementToken };
}

async function createSubscription(
  dependencies: RelayDependencies,
  registration: Registration,
): Promise<ReturnType<typeof subscriptionCredentials>> {
  const id = crypto.randomUUID();
  const deliveryToken = generateBearerToken();
  const managementToken = generateBearerToken();
  await dependencies.database.createSubscription({
    id,
    installation_id: registration.installationId,
    device_token_encrypted: sealDeviceToken(registration.apnsToken.toLowerCase(), id, dependencies.config.dataKey),
    environment: registration.environment,
    topic: registration.topic,
    node_origin: normalizedNodeOrigin(registration.nodeOrigin),
    app_version: registration.appVersion,
    delivery_token_hash: tokenHash(deliveryToken),
    management_token_hash: tokenHash(managementToken),
  });
  return subscriptionCredentials(id, deliveryToken, managementToken);
}

async function updateSubscription(
  dependencies: RelayDependencies,
  subscription: SubscriptionRow,
  registration: Registration,
): Promise<ReturnType<typeof subscriptionCredentials>> {
  const deliveryToken = generateBearerToken();
  const managementToken = generateBearerToken();
  await dependencies.database.updateSubscription(subscription.id, {
    installation_id: registration.installationId,
    device_token_encrypted: sealDeviceToken(
      registration.apnsToken.toLowerCase(),
      subscription.id,
      dependencies.config.dataKey,
    ),
    environment: registration.environment,
    topic: registration.topic,
    node_origin: normalizedNodeOrigin(registration.nodeOrigin),
    app_version: registration.appVersion,
    delivery_token_hash: tokenHash(deliveryToken),
    management_token_hash: tokenHash(managementToken),
  });
  return subscriptionCredentials(subscription.id, deliveryToken, managementToken);
}

function invalidDeviceToken(status: number, reason?: string): boolean {
  return status === 410
    || reason === 'BadDeviceToken'
    || reason === 'Unregistered'
    || reason === 'DeviceTokenNotForTopic';
}

function apnsFailureStatus(status: number, reason?: string): number {
  if (invalidDeviceToken(status, reason)) return 410;
  if (status === 429) return 429;
  if (status === 403 || status >= 500) return 502;
  return 422;
}

export function createRelayServer(dependencies: RelayDependencies): http.Server {
  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', 'http://relay.local');
      if (request.method === 'GET' && url.pathname === '/healthz') {
        respond(response, 200, { ok: true });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/v1/subscriptions') {
        const address = clientAddress(request);
        if (!registrationAllowed(address)) {
          respond(response, 429, { error: 'Registration rate limit exceeded' });
          return;
        }
        const parsed = registrationSchema.safeParse(await jsonBody(request));
        if (!parsed.success) {
          respond(response, 400, { error: 'Invalid subscription registration' });
          return;
        }
        respond(response, 201, await createSubscription(dependencies, parsed.data));
        return;
      }

      const match = url.pathname.match(/^\/v1\/subscriptions\/([0-9a-f-]+)$/i);
      if (match && request.method === 'PUT') {
        const subscription = await authenticate(
          dependencies.database,
          match[1],
          bearerToken(request),
          'management',
        );
        if (!subscription) {
          respond(response, 401, { error: 'Invalid subscription credentials' });
          return;
        }
        const parsed = registrationSchema.safeParse(await jsonBody(request));
        if (!parsed.success) {
          respond(response, 400, { error: 'Invalid subscription registration' });
          return;
        }
        respond(response, 200, await updateSubscription(dependencies, subscription, parsed.data));
        return;
      }

      if (match && request.method === 'DELETE') {
        const subscription = await authenticate(
          dependencies.database,
          match[1],
          bearerToken(request),
          'management',
        );
        if (!subscription) {
          respond(response, 401, { error: 'Invalid subscription credentials' });
          return;
        }
        await dependencies.database.deleteSubscription(subscription.id);
        respond(response, 204);
        return;
      }

      const deliveryMatch = url.pathname.match(/^\/v1\/subscriptions\/([0-9a-f-]+)\/deliver$/i);
      if (deliveryMatch && request.method === 'POST') {
        const subscription = await authenticate(
          dependencies.database,
          deliveryMatch[1],
          bearerToken(request),
          'delivery',
        );
        if (!subscription) {
          respond(response, 401, { error: 'Invalid delivery credentials' });
          return;
        }
        const parsed = eventSchema.safeParse(await jsonBody(request));
        if (!parsed.success) {
          respond(response, 400, { error: 'Invalid push event' });
          return;
        }

        const recent = await dependencies.database.recentDeliveryCount(
          subscription.id,
          Math.floor(Date.now() / 1000) - 60,
        );
        if (recent >= 60) {
          respond(response, 429, { error: 'Delivery rate limit exceeded' });
          return;
        }

        const event = parsed.data as PushEvent;
        const claim = await dependencies.database.claimDelivery(subscription.id, event.eventId, event.type);
        if (claim === 'delivered') {
          respond(response, 202, { delivered: true, duplicate: true });
          return;
        }
        if (claim === 'busy') {
          respond(response, 429, { error: 'Delivery is already in progress' });
          return;
        }

        const deviceToken = openDeviceToken(
          subscription.device_token_encrypted,
          subscription.id,
          dependencies.config.dataKey,
        );
        const result = await dependencies.apns.send(subscription.environment, deviceToken, {
          ...event,
          subscriptionId: subscription.id,
        });
        if (result.status === 200) {
          await dependencies.database.finishDelivery(
            subscription.id,
            event.eventId,
            'delivered',
            result.apnsId,
          );
          respond(response, 202, { delivered: true });
          return;
        }

        await dependencies.database.finishDelivery(
          subscription.id,
          event.eventId,
          'failed',
          result.apnsId,
          result.reason || `APNs returned ${result.status}`,
        );
        if (invalidDeviceToken(result.status, result.reason)) {
          await dependencies.database.disableSubscription(subscription.id);
        }
        respond(response, apnsFailureStatus(result.status, result.reason), {
          error: result.reason || 'Apple rejected the notification',
        });
        return;
      }

      respond(response, 404, { error: 'Not found' });
    } catch (error) {
      console.error('[Push Relay] Request failed:', error instanceof Error ? error.message : error);
      respond(response, 500, { error: 'Internal server error' });
    }
  });
}

async function main(): Promise<void> {
  const config = loadConfiguration();
  const database = new PushRelayDatabase(config.databasePath);
  await database.connect();
  const server = createRelayServer({
    config,
    database,
    apns: new ApplePushNotificationService(config),
  });

  server.listen(config.port, config.host, () => {
    console.log(`[Push Relay] Listening on ${config.host}:${config.port}`);
  });

  const shutdown = () => {
    server.close(() => void database.close().finally(() => process.exit(0)));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (process.env.NODE_ENV !== 'test') {
  void main().catch((error) => {
    console.error('[Push Relay] Startup failed:', error);
    process.exit(1);
  });
}
