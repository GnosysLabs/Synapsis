import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  findMany: vi.fn(),
}));

vi.mock('@/db', () => ({
  db: {
    query: {
      nodes: {
        findFirst: mocks.findFirst,
        findMany: mocks.findMany,
      },
    },
  },
}));

import { GET } from './route';

describe('GET /api/node/logo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('NEXT_PUBLIC_NODE_DOMAIN', 'adult.example');
    mocks.findMany.mockResolvedValue([]);
  });

  it('serves an adult node logo without requiring sensitive-content access', async () => {
    mocks.findFirst.mockResolvedValue({
      domain: 'adult.example',
      isNsfw: true,
      logoData: 'data:image/png;base64,aGk=',
    });

    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/png');
    expect(Buffer.from(await response.arrayBuffer()).toString('utf8')).toBe('hi');
  });
});
