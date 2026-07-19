import { readFile } from 'node:fs/promises';
import http2 from 'node:http2';
import { importPKCS8, SignJWT } from 'jose';

import type { ApnsEnvironment } from './database';
import type { PushRelayConfiguration } from './config';

interface PushEventBase {
  eventId: string;
  actorName: string;
  subscriptionId?: string;
}

export interface NotificationPushEvent extends PushEventBase {
  notificationId: string;
  type: 'follow' | 'reply' | 'mention' | 'like' | 'repost';
  postId?: string;
}

export interface MessagePushEvent extends PushEventBase {
  messageId: string;
  type: 'message';
}

export type PushEvent = NotificationPushEvent | MessagePushEvent;

export interface ApnsResponse {
  status: number;
  apnsId?: string;
  reason?: string;
}

export interface ApnsSender {
  send(environment: ApnsEnvironment, deviceToken: string, event: PushEvent): Promise<ApnsResponse>;
}

function cleanActorName(value: string): string {
  const normalized = value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  return (normalized || 'Someone').slice(0, 80);
}

export function notificationTitle(event: PushEvent): string {
  const actor = cleanActorName(event.actorName);
  switch (event.type) {
    case 'follow': return `${actor} followed you`;
    case 'reply': return `${actor} replied to your post`;
    case 'mention': return `${actor} mentioned you`;
    case 'like': return `${actor} liked your post`;
    case 'repost': return `${actor} reposted your post`;
    case 'message': return `${actor} sent you a message`;
  }
}

export function buildApnsPayload(event: PushEvent): string {
  const routing = event.type === 'message'
    ? { messageId: event.messageId }
    : {
        notificationId: event.notificationId,
        ...(event.postId ? { postId: event.postId } : {}),
      };
  return JSON.stringify({
    aps: {
      alert: {
        title: notificationTitle(event),
        body: event.type === 'message'
          ? 'Open Synapsis to read it.'
          : 'Open Synapsis to view the notification.',
      },
      sound: 'default',
      badge: 1,
      'thread-id': event.type === 'message' ? 'messages' : 'notifications',
    },
    synapsis: {
      type: event.type,
      ...routing,
      ...(event.subscriptionId ? { subscriptionId: event.subscriptionId } : {}),
    },
  });
}

interface CachedSigningKey {
  key: CryptoKey;
  jwt?: string;
  jwtCreatedAt?: number;
}

export class ApplePushNotificationService implements ApnsSender {
  private readonly signingKeys = new Map<ApnsEnvironment, CachedSigningKey>();

  constructor(private readonly config: PushRelayConfiguration) {}

  async send(environment: ApnsEnvironment, deviceToken: string, event: PushEvent): Promise<ApnsResponse> {
    const authority = environment === 'production'
      ? 'https://api.push.apple.com'
      : 'https://api.sandbox.push.apple.com';
    const jwt = await this.jwt(environment);
    const payload = buildApnsPayload(event);
    if (Buffer.byteLength(payload) > 4096) throw new Error('APNs payload exceeds 4 KB');

    return await new Promise<ApnsResponse>((resolve, reject) => {
      const client = http2.connect(authority);
      let settled = false;
      let responseStatus = 0;
      let responseApnsId: string | undefined;
      const chunks: Buffer[] = [];

      const finish = (result?: ApnsResponse, error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        client.close();
        if (error) reject(error);
        else resolve(result!);
      };

      const timeout = setTimeout(() => {
        client.destroy();
        finish(undefined, new Error('APNs request timed out'));
      }, 15_000);

      client.once('error', (error) => finish(undefined, error));
      const request = client.request({
        ':method': 'POST',
        ':path': `/3/device/${deviceToken}`,
        authorization: `bearer ${jwt}`,
        'apns-topic': this.config.topic,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'apns-expiration': String(Math.floor(Date.now() / 1000) + 3600),
      });
      request.setEncoding('utf8');
      request.on('response', (headers) => {
        responseStatus = Number(headers[':status'] || 0);
        const apnsId = headers['apns-id'];
        responseApnsId = Array.isArray(apnsId) ? apnsId[0] : apnsId;
      });
      request.on('data', (chunk: string) => chunks.push(Buffer.from(chunk)));
      request.once('error', (error) => finish(undefined, error));
      request.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let reason: string | undefined;
        if (text) {
          try { reason = (JSON.parse(text) as { reason?: string }).reason; } catch { reason = text.slice(0, 200); }
        }
        finish({ status: responseStatus, apnsId: responseApnsId, reason });
      });
      request.end(payload);
    });
  }

  private async jwt(environment: ApnsEnvironment): Promise<string> {
    let cached = this.signingKeys.get(environment);
    if (!cached) {
      const keyConfig = this.config[environment];
      const privateKey = await readFile(keyConfig.keyFile, 'utf8');
      cached = { key: await importPKCS8(privateKey, 'ES256') };
      this.signingKeys.set(environment, cached);
    }

    const now = Math.floor(Date.now() / 1000);
    if (!cached.jwt || !cached.jwtCreatedAt || now - cached.jwtCreatedAt >= 50 * 60) {
      cached.jwt = await new SignJWT({})
        .setProtectedHeader({ alg: 'ES256', kid: this.config[environment].keyId })
        .setIssuer(this.config.teamId)
        .setIssuedAt(now)
        .sign(cached.key);
      cached.jwtCreatedAt = now;
    }
    return cached.jwt;
  }
}
