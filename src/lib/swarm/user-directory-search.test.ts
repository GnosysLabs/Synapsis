import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    select: vi.fn(),
    fetchDirectory: vi.fn(),
    inArray: vi.fn((column: unknown, values: unknown[]) => ({ operator: 'inArray', column, values })),
}));

vi.mock('drizzle-orm', () => {
    const expression = (operator: string) => (...values: unknown[]) => ({ operator, values });
    return {
        and: expression('and'),
        asc: expression('asc'),
        eq: expression('eq'),
        gte: expression('gte'),
        inArray: mocks.inArray,
        isNotNull: expression('isNotNull'),
        isNull: expression('isNull'),
        like: expression('like'),
        or: expression('or'),
    };
});

vi.mock('@/db', () => ({
    db: { select: mocks.select },
    handleRegistry: { handle: 'handle', nodeDomain: 'nodeDomain', deletedAt: 'deletedAt' },
    users: {
        handle: 'users.handle',
        displayName: 'users.displayName',
        isLocalAccount: 'users.isLocalAccount',
        profileVersion: 'users.profileVersion',
        profileDocumentJson: 'users.profileDocumentJson',
    },
    swarmNodes: {
        domain: 'swarmNodes.domain',
        isActive: 'swarmNodes.isActive',
        isBlocked: 'swarmNodes.isBlocked',
        isNsfw: 'swarmNodes.isNsfw',
        nsfwClassificationKnown: 'swarmNodes.nsfwClassificationKnown',
    },
}));
vi.mock('@/lib/swarm/user-directory', () => ({
    fetchSwarmUserDirectory: mocks.fetchDirectory,
}));

import { searchKnownSwarmUsers } from './user-directory-search';

function registryQuery(rows: unknown[]) {
    const builder = {
        from: vi.fn(),
        where: vi.fn(),
        orderBy: vi.fn(),
        limit: vi.fn().mockResolvedValue(rows),
        then: (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) => (
            Promise.resolve(rows).then(resolve, reject)
        ),
    };
    builder.from.mockReturnValue(builder);
    builder.where.mockReturnValue(builder);
    builder.orderBy.mockReturnValue(builder);
    return builder;
}

describe('searchKnownSwarmUsers', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.select
            .mockReturnValueOnce(registryQuery([
                { handle: 'theredpillgod@rprh.link', nodeDomain: 'rprh.link' },
            ]))
            .mockReturnValueOnce(registryQuery([{
                domain: 'rprh.link',
                isNsfw: true,
                nsfwClassificationKnown: true,
            }]))
            .mockReturnValueOnce(registryQuery([{
                handle: 'theredpillgod@rprh.link',
                displayName: 'The Red Pill God',
            }]));
        mocks.fetchDirectory.mockResolvedValue([{
            handle: 'theredpillgod@rprh.link',
            displayName: 'The Red Pill God',
            avatarUrl: null,
            isRemote: true,
            nodeDomain: 'rprh.link',
            nodeIsNsfw: true,
        }]);
    });

    it('searches the complete local node registry without an active-node ceiling', async () => {
        await expect(searchKnownSwarmUsers('theredpillgod', {
            limit: 8,
            localDomain: 'local.com',
        })).resolves.toMatchObject([{
            handle: 'theredpillgod@rprh.link',
            displayName: 'The Red Pill God',
        }]);

        expect(mocks.inArray).toHaveBeenCalledWith('swarmNodes.domain', ['rprh.link']);
        expect(mocks.fetchDirectory).toHaveBeenCalledTimes(1);
        expect(mocks.fetchDirectory).toHaveBeenCalledWith(
            'theredpillgod',
            'rprh.link',
            8,
            expect.objectContaining({ knownNode: true }),
        );
    });

    it('uses a signed cached display name when directory enrichment is unavailable', async () => {
        mocks.fetchDirectory.mockResolvedValue([]);

        await expect(searchKnownSwarmUsers('theredpillgod', {
            limit: 8,
            localDomain: 'local.com',
        })).resolves.toMatchObject([{
            handle: 'theredpillgod@rprh.link',
            displayName: 'The Red Pill God',
        }]);
    });

    it('keeps the full handle out of the last-resort display-name fallback', async () => {
        mocks.select.mockReset();
        mocks.select
            .mockReturnValueOnce(registryQuery([
                { handle: 'theredpillgod@rprh.link', nodeDomain: 'rprh.link' },
            ]))
            .mockReturnValueOnce(registryQuery([{
                domain: 'rprh.link',
                isNsfw: true,
                nsfwClassificationKnown: true,
            }]))
            .mockReturnValueOnce(registryQuery([]));
        mocks.fetchDirectory.mockResolvedValue([]);

        await expect(searchKnownSwarmUsers('theredpillgod', {
            limit: 8,
            localDomain: 'local.com',
        })).resolves.toMatchObject([{
            handle: 'theredpillgod@rprh.link',
            displayName: 'theredpillgod',
        }]);
    });
});
