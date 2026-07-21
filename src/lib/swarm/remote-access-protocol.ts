import type { SafeFederationResponse } from './safe-federation-http';

export const NODE_BLOCKED_CODE = 'NODE_BLOCKED' as const;
export const ORIGIN_UNAVAILABLE_CONTENT = 'This post is unavailable because its origin disconnected federation access.';

export function isRemoteNodeBlockResponse(response: SafeFederationResponse): boolean {
  if (response.status !== 403) return false;
  try {
    const payload = response.json();
    return Boolean(payload && typeof payload === 'object' && 'code' in payload
      && payload.code === NODE_BLOCKED_CODE);
  } catch {
    return false;
  }
}
