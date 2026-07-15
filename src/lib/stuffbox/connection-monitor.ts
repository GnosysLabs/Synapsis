export interface StuffboxConnectionResult {
  type?: string;
  success?: boolean;
  message?: string;
  attemptId?: string;
}

interface MonitorOptions {
  checkConnected: () => Promise<boolean>;
  subscribe: (receive: (result: StuffboxConnectionResult) => void) => () => void;
  signal?: AbortSignal;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

export class StuffboxConnectionCancelledError extends Error {
  constructor() {
    super('Stuffbox connection cancelled');
    this.name = 'StuffboxConnectionCancelledError';
  }
}

/**
 * Wait for the server to confirm a Stuffbox connection.
 *
 * Popup window state is intentionally absent here. Cross-Origin-Opener-Policy
 * can make a live cross-origin popup appear closed to its opener. Messages are
 * useful accelerators, but the node's persisted connection is the authority.
 */
export function monitorStuffboxConnection({
  checkConnected,
  subscribe,
  signal,
  pollIntervalMs = 750,
  timeoutMs = 10 * 60_000,
}: MonitorOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let checking = false;
    let cleanupSubscription = () => {};
    const timers: {
      interval?: ReturnType<typeof setInterval>;
      timeout?: ReturnType<typeof setTimeout>;
    } = {};

    const abort = () => finish(new StuffboxConnectionCancelledError());
    signal?.addEventListener('abort', abort, { once: true });

    function cleanup() {
      if (timers.interval !== undefined) globalThis.clearInterval(timers.interval);
      if (timers.timeout !== undefined) globalThis.clearTimeout(timers.timeout);
      signal?.removeEventListener('abort', abort);
      cleanupSubscription();
    }

    function finish(error?: Error) {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    }

    async function checkNow() {
      if (settled || checking) return;
      checking = true;
      try {
        if (await checkConnected()) finish();
      } catch {
        // Transient status failures are retried until timeout or cancellation.
      } finally {
        checking = false;
      }
    }

    if (signal?.aborted) {
      abort();
      return;
    }

    cleanupSubscription = subscribe((result) => {
      if (result.type !== 'synapsis:stuffbox') return;
      if (result.success) {
        void checkNow();
      } else {
        finish(new Error(result.message || 'Stuffbox access was not approved.'));
      }
    });
    if (settled) {
      cleanupSubscription();
      return;
    }

    timers.interval = globalThis.setInterval(() => void checkNow(), pollIntervalMs);
    timers.timeout = globalThis.setTimeout(() => {
      finish(new Error('Stuffbox connection timed out. You can safely try again.'));
    }, timeoutMs);

    void checkNow();
  });
}
