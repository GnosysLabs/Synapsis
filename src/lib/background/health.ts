export type BackgroundTaskName = 'gossip' | 'contentSync' | 'changeNotice' | 'followSync' | 'mentions' | 'push';

interface TaskHeartbeat {
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
}

interface BackgroundHealthState {
  startedAt?: string;
  tasks: Partial<Record<BackgroundTaskName, TaskHeartbeat>>;
}

const globalHealth = globalThis as typeof globalThis & {
  synapsisBackgroundHealth?: BackgroundHealthState;
};

function state(): BackgroundHealthState {
  globalHealth.synapsisBackgroundHealth ??= { tasks: {} };
  return globalHealth.synapsisBackgroundHealth;
}

export function markBackgroundStarted(): void {
  state().startedAt ??= new Date().toISOString();
}

export function markBackgroundTask(
  task: BackgroundTaskName,
  outcome: { success: true } | { success: false; error: unknown },
): void {
  const timestamp = new Date().toISOString();
  const existing = state().tasks[task] || {};
  state().tasks[task] = outcome.success
    ? { ...existing, lastAttemptAt: timestamp, lastSuccessAt: timestamp, lastError: undefined }
    : {
        ...existing,
        lastAttemptAt: timestamp,
        lastError: outcome.error instanceof Error ? outcome.error.message.slice(0, 300) : String(outcome.error).slice(0, 300),
      };
}

export function getBackgroundHealth(): BackgroundHealthState {
  const current = state();
  return {
    startedAt: current.startedAt,
    tasks: structuredClone(current.tasks),
  };
}
