import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    findFirst: vi.fn(),
    findMany: vi.fn(),
    insert: vi.fn(),
    values: vi.fn(),
    onConflictDoNothing: vi.fn(),
}));

vi.mock('@/db', () => ({
    db: {
        query: { nodes: { findFirst: mocks.findFirst, findMany: mocks.findMany } },
        insert: mocks.insert,
    },
    nodes: { domain: 'nodes.domain' },
}));

import { ensureLocalNodeRecord } from './local-node';

describe('local node initialization', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubEnv('NEXT_PUBLIC_NODE_DOMAIN', 'fresh.example');
        vi.stubEnv('NEXT_PUBLIC_NODE_NAME', 'Fresh node');
        vi.stubEnv('NEXT_PUBLIC_NODE_DESCRIPTION', 'Fresh short description');
        mocks.insert.mockReturnValue({ values: mocks.values });
        mocks.values.mockReturnValue({ onConflictDoNothing: mocks.onConflictDoNothing });
        mocks.onConflictDoNothing.mockResolvedValue(undefined);
    });

    it('creates a fresh node as explicitly general-audience and returns it', async () => {
        const initialized = {
            id: 'node-1',
            domain: 'fresh.example',
            name: 'Fresh node',
            description: 'Fresh short description',
            isNsfw: false,
        };
        mocks.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(initialized);
        mocks.findMany.mockResolvedValueOnce([]);

        await expect(ensureLocalNodeRecord()).resolves.toEqual(initialized);
        expect(mocks.values).toHaveBeenCalledWith(expect.objectContaining({
            domain: 'fresh.example',
            name: 'Fresh node',
            description: 'Fresh short description',
            isNsfw: false,
        }));
        expect(mocks.onConflictDoNothing).toHaveBeenCalledWith({ target: 'nodes.domain' });
    });

    it('preserves an existing node classification', async () => {
        const existing = { id: 'node-1', domain: 'fresh.example', isNsfw: true };
        mocks.findFirst.mockResolvedValue(existing);

        await expect(ensureLocalNodeRecord()).resolves.toBe(existing);
        expect(mocks.insert).not.toHaveBeenCalled();
    });
});
