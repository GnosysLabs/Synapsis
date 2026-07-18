export const MAX_FEDERATION_JSON_BYTES = 256 * 1024;

export class FederationRequestBodyError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 413,
  ) {
    super(message);
    this.name = 'FederationRequestBodyError';
  }
}

/** Read JSON without allowing an unbounded body to be buffered by request.json(). */
export async function readLimitedJson(
  request: Request,
  maximumBytes = MAX_FEDERATION_JSON_BYTES,
): Promise<unknown> {
  const declaredLength = request.headers.get('content-length');
  if (declaredLength && /^\d+$/.test(declaredLength)
    && Number(declaredLength) > maximumBytes) {
    throw new FederationRequestBodyError('Federation request body is too large', 413);
  }

  if (!request.body) {
    throw new FederationRequestBodyError('Federation request body is required', 400);
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maximumBytes) {
        await reader.cancel();
        throw new FederationRequestBodyError('Federation request body is too large', 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const combined = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(combined);
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof FederationRequestBodyError) throw error;
    throw new FederationRequestBodyError('Federation request body is not valid JSON', 400);
  }
}
