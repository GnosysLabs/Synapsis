import http from 'http';

const DEFAULT_SOCKET_PATH = '/var/run/synapsis-updater/updater.sock';
const REQUEST_TIMEOUT_MS = 4000;

export interface HostUpdaterStatus {
  available: boolean;
  status: 'unavailable' | 'idle' | 'updating' | 'success' | 'error';
  message?: string;
  lastStartedAt?: string | null;
  lastFinishedAt?: string | null;
  lastExitCode?: number | null;
  lastError?: string | null;
  pid?: number | null;
}

function getUpdaterConfig() {
  const socketPath = process.env.HOST_UPDATER_SOCKET || DEFAULT_SOCKET_PATH;
  const token = process.env.HOST_UPDATER_TOKEN || '';

  return {
    socketPath,
    token,
    enabled: Boolean(socketPath && token),
  };
}

function requestUpdater<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const { socketPath, token, enabled } = getUpdaterConfig();

  if (!enabled) {
    return Promise.reject(new Error('Host updater is not configured'));
  }

  const payload = body ? JSON.stringify(body) : undefined;

  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        method,
        socketPath,
        path,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(payload
            ? {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
              }
            : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];

        response.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const data = text ? JSON.parse(text) : {};

          if ((response.statusCode || 500) >= 400) {
            const message = data.error || `Updater request failed with ${response.statusCode}`;
            reject(new Error(message));
            return;
          }

          resolve(data as T);
        });
      }
    );

    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error('Host updater request timed out'));
    });

    request.on('error', (error) => {
      reject(error);
    });

    if (payload) {
      request.write(payload);
    }

    request.end();
  });
}

export async function getHostUpdaterStatus(): Promise<HostUpdaterStatus> {
  const config = getUpdaterConfig();
  if (!config.enabled) {
    return {
      available: false,
      status: 'unavailable',
      message: 'Host updater is not configured for this install.',
    };
  }

  try {
    const status = await requestUpdater<HostUpdaterStatus>('GET', '/status');
    return {
      ...status,
      available: true,
    };
  } catch (error) {
    return {
      available: false,
      status: 'unavailable',
      message: error instanceof Error ? error.message : 'Host updater is unavailable.',
    };
  }
}

export async function triggerHostUpdate() {
  return requestUpdater<{ ok: boolean; status: string; message?: string }>('POST', '/update');
}
