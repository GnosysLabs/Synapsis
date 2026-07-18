import { resolve } from 'node:path';

export const SYNAPSIS_IOS_TOPIC = 'xyz.gnosyslabs.synapsis';

export interface ApnsKeyConfiguration {
  keyId: string;
  keyFile: string;
}

export interface PushRelayConfiguration {
  host: string;
  port: number;
  databasePath: string;
  dataKey: Buffer;
  topic: string;
  teamId: string;
  production: ApnsKeyConfiguration;
  sandbox: ApnsKeyConfiguration;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function dataKey(): Buffer {
  const encoded = required('PUSH_RELAY_DATA_KEY');
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32) {
    throw new Error('PUSH_RELAY_DATA_KEY must be a base64-encoded 32-byte key');
  }
  return key;
}

export function loadConfiguration(): PushRelayConfiguration {
  const configuredTopic = process.env.APNS_TOPIC?.trim() || SYNAPSIS_IOS_TOPIC;
  if (configuredTopic !== SYNAPSIS_IOS_TOPIC) {
    throw new Error(`APNS_TOPIC must be ${SYNAPSIS_IOS_TOPIC}`);
  }

  const port = Number.parseInt(process.env.PORT || '8787', 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be a valid TCP port');
  }

  return {
    host: process.env.HOST?.trim() || '127.0.0.1',
    port,
    databasePath: resolve(process.env.PUSH_RELAY_DATABASE_PATH || './data/push-relay.db'),
    dataKey: dataKey(),
    topic: configuredTopic,
    teamId: required('APNS_TEAM_ID'),
    production: {
      keyId: required('APNS_PRODUCTION_KEY_ID'),
      keyFile: resolve(required('APNS_PRODUCTION_KEY_FILE')),
    },
    sandbox: {
      keyId: required('APNS_SANDBOX_KEY_ID'),
      keyFile: resolve(required('APNS_SANDBOX_KEY_FILE')),
    },
  };
}
