import crypto from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ApnsResponse, ApnsSender, PushEvent } from './apns';
import type { PushRelayConfiguration } from './config';
import { PushRelayDatabase, type ApnsEnvironment } from './database';
import { createRelayServer } from './server';

class RecordingApnsSender implements ApnsSender {
  calls: Array<{ environment: ApnsEnvironment; deviceToken: string; event: PushEvent }> = [];

  async send(
    environment: ApnsEnvironment,
    deviceToken: string,
    event: PushEvent,
  ): Promise<ApnsResponse> {
    this.calls.push({ environment, deviceToken, event });
    return { status: 200, apnsId: crypto.randomUUID() };
  }
}

describe('push relay protocol', () => {
  let directory: string;
  let database: PushRelayDatabase;
  let apns: RecordingApnsSender;
  let server: ReturnType<typeof createRelayServer>;
  let baseURL: string;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'synapsis-push-relay-'));
    database = new PushRelayDatabase(join(directory, 'relay.db'));
    await database.connect();
    apns = new RecordingApnsSender();
    const config: PushRelayConfiguration = {
      host: '127.0.0.1',
      port: 0,
      databasePath: join(directory, 'relay.db'),
      dataKey: crypto.randomBytes(32),
      topic: 'xyz.gnosyslabs.synapsis',
      teamId: 'TEAMID1234',
      production: { keyId: 'PRODUCTION', keyFile: '/unused' },
      sandbox: { keyId: 'SANDBOX', keyFile: '/unused' },
    };
    server = createRelayServer({ config, database, apns });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    baseURL = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('registers directly from iOS and delivers once using a node-scoped token', async () => {
    const apnsToken = 'ab'.repeat(32);
    const registration = {
      installationId: crypto.randomUUID(),
      apnsToken,
      environment: 'sandbox',
      topic: 'xyz.gnosyslabs.synapsis',
      nodeOrigin: 'https://community.example',
      appVersion: '1.0',
    };
    const registrationResponse = await fetch(`${baseURL}/v1/subscriptions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(registration),
    });
    expect(registrationResponse.status).toBe(201);
    const credentials = await registrationResponse.json() as {
      subscriptionId: string;
      deliveryToken: string;
      managementToken: string;
    };

    const stored = await database.getSubscription(credentials.subscriptionId);
    expect(stored?.device_token_encrypted).not.toContain(apnsToken);
    expect(stored?.delivery_token_hash).not.toBe(credentials.deliveryToken);

    const event = {
      eventId: crypto.randomUUID(),
      notificationId: crypto.randomUUID(),
      type: 'mention',
      actorName: 'Alice',
      actorAvatarUrl: 'https://cdn.example/alice.png',
      postId: crypto.randomUUID(),
    };
    const deliver = () => fetch(
      `${baseURL}/v1/subscriptions/${credentials.subscriptionId}/deliver`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${credentials.deliveryToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(event),
      },
    );
    expect((await deliver()).status).toBe(202);
    expect((await deliver()).status).toBe(202);
    expect(apns.calls).toHaveLength(1);
    expect(apns.calls[0]).toMatchObject({ environment: 'sandbox', deviceToken: apnsToken });
    expect(apns.calls[0]?.event.subscriptionId).toBe(credentials.subscriptionId);

    const messageEvent = {
      eventId: crypto.randomUUID(),
      messageId: crypto.randomUUID(),
      type: 'message',
      actorName: 'Charlie',
    };
    const messageDelivery = await fetch(
      `${baseURL}/v1/subscriptions/${credentials.subscriptionId}/deliver`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${credentials.deliveryToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(messageEvent),
      },
    );
    expect(messageDelivery.status).toBe(202);
    expect(apns.calls[1]?.event).toMatchObject({
      ...messageEvent,
      subscriptionId: credentials.subscriptionId,
    });

    const unauthorized = await fetch(
      `${baseURL}/v1/subscriptions/${credentials.subscriptionId}/deliver`,
      {
        method: 'POST',
        headers: { authorization: 'Bearer wrong-token', 'content-type': 'application/json' },
        body: JSON.stringify({ ...event, eventId: crypto.randomUUID() }),
      },
    );
    expect(unauthorized.status).toBe(401);
  });

  it('rotates credentials on update and revokes the subscription', async () => {
    const registration = {
      installationId: crypto.randomUUID(),
      apnsToken: 'cd'.repeat(32),
      environment: 'production',
      topic: 'xyz.gnosyslabs.synapsis',
      nodeOrigin: 'https://another-community.example',
      appVersion: '1.0',
    };
    const createdResponse = await fetch(`${baseURL}/v1/subscriptions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(registration),
    });
    const created = await createdResponse.json() as {
      subscriptionId: string;
      deliveryToken: string;
      managementToken: string;
    };

    const updatedResponse = await fetch(`${baseURL}/v1/subscriptions/${created.subscriptionId}`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${created.managementToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ...registration, appVersion: '1.1' }),
    });
    expect(updatedResponse.status).toBe(200);
    const updated = await updatedResponse.json() as typeof created;
    expect(updated.deliveryToken).not.toBe(created.deliveryToken);
    expect(updated.managementToken).not.toBe(created.managementToken);

    const deleted = await fetch(`${baseURL}/v1/subscriptions/${created.subscriptionId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${updated.managementToken}` },
    });
    expect(deleted.status).toBe(204);
    expect(await database.getSubscription(created.subscriptionId)).toBeUndefined();

    const rejected = await fetch(`${baseURL}/v1/subscriptions/${created.subscriptionId}/deliver`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${updated.deliveryToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        eventId: crypto.randomUUID(),
        notificationId: crypto.randomUUID(),
        type: 'like',
        actorName: 'Bob',
      }),
    });
    expect(rejected.status).toBe(401);
  });
});
