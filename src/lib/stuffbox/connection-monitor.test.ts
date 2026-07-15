import { describe, expect, it } from 'vitest';
import {
  monitorStuffboxConnection,
  StuffboxConnectionCancelledError,
  type StuffboxConnectionResult,
} from './connection-monitor';

function subscription() {
  let receive: ((result: StuffboxConnectionResult) => void) | undefined;
  return {
    subscribe: (next: (result: StuffboxConnectionResult) => void) => {
      receive = next;
      return () => { receive = undefined; };
    },
    send: (result: StuffboxConnectionResult) => receive?.(result),
  };
}

describe('monitorStuffboxConnection', () => {
  it('uses persisted server state as the source of truth', async () => {
    const messages = subscription();
    let checks = 0;
    const result = monitorStuffboxConnection({
      subscribe: messages.subscribe,
      checkConnected: async () => ++checks >= 3,
      pollIntervalMs: 1,
      timeoutMs: 100,
    });

    await expect(result).resolves.toBeUndefined();
    expect(checks).toBeGreaterThanOrEqual(3);
  });

  it('verifies success messages against server state before resolving', async () => {
    const messages = subscription();
    let connected = false;
    const result = monitorStuffboxConnection({
      subscribe: messages.subscribe,
      checkConnected: async () => connected,
      pollIntervalMs: 20,
      timeoutMs: 100,
    });

    messages.send({ type: 'synapsis:stuffbox', success: true });
    connected = true;
    messages.send({ type: 'synapsis:stuffbox', success: true });

    await expect(result).resolves.toBeUndefined();
  });

  it('surfaces an explicit denial from Stuffbox', async () => {
    const messages = subscription();
    const result = monitorStuffboxConnection({
      subscribe: messages.subscribe,
      checkConnected: async () => false,
      pollIntervalMs: 20,
      timeoutMs: 100,
    });

    messages.send({ type: 'synapsis:stuffbox', success: false, message: 'Access denied.' });
    await expect(result).rejects.toThrow('Access denied.');
  });

  it('can be cancelled without waiting for the timeout', async () => {
    const messages = subscription();
    const controller = new AbortController();
    const result = monitorStuffboxConnection({
      subscribe: messages.subscribe,
      checkConnected: async () => false,
      signal: controller.signal,
      pollIntervalMs: 20,
      timeoutMs: 100,
    });

    controller.abort();
    await expect(result).rejects.toBeInstanceOf(StuffboxConnectionCancelledError);
  });
});

