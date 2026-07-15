export interface StoragePageStatus {
  provider: 'stuffbox' | null;
}

export type StoragePageState = 'loading' | 'error' | 'connected' | 'disconnected';

export function getStoragePageState(
  status: StoragePageStatus | null,
  isLoading: boolean,
): StoragePageState {
  if (isLoading) return 'loading';
  if (!status) return 'error';
  return status.provider === 'stuffbox' ? 'connected' : 'disconnected';
}
