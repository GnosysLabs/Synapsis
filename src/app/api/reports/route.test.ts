import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db';
import { requireSignedAction } from '@/lib/auth/verify-signature';
import { POST } from './route';

const mocks = vi.hoisted(() => ({
    findPost: vi.fn(),
    findUser: vi.fn(),
    insertValues: vi.fn(),
}));

vi.mock('@/lib/auth/verify-signature', () => {
    class MockSignedActionError extends Error {
        readonly code: string;

        constructor(code: string) {
            super(code);
            this.code = code;
        }
    }

    return {
        requireSignedAction: vi.fn(),
        SignedActionError: MockSignedActionError,
    };
});

vi.mock('@/db', () => ({
    reports: {},
    db: {
        query: {
            posts: { findFirst: mocks.findPost },
            users: { findFirst: mocks.findUser },
        },
        insert: vi.fn(() => ({ values: mocks.insertValues })),
    },
}));

const reporter = {
    id: '00000000-0000-4000-8000-000000000001',
    handle: 'reporter@social.example',
};
const previousNodeDomain = process.env.NEXT_PUBLIC_NODE_DOMAIN;

function reportRequest(targetId: string) {
    return new Request('https://social.example/api/reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            action: 'report',
            data: {
                targetType: 'user',
                targetId,
                reason: 'Harassment from this account',
            },
            did: 'did:key:reporter',
            handle: reporter.handle,
            ts: Date.now(),
            nonce: 'nonce',
            sig: 'signature',
        }),
    });
}

describe('POST /api/reports user targets', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        process.env.NEXT_PUBLIC_NODE_DOMAIN = 'social.example';
        vi.mocked(requireSignedAction).mockResolvedValue(reporter as never);
        mocks.insertValues.mockImplementation((values) => ({
            returning: vi.fn().mockResolvedValue([{ id: 'report-1', ...values }]),
        }));
    });

    afterEach(() => {
        if (previousNodeDomain === undefined) {
            delete process.env.NEXT_PUBLIC_NODE_DOMAIN;
        } else {
            process.env.NEXT_PUBLIC_NODE_DOMAIN = previousNodeDomain;
        }
    });

    it('submits a signed report for a local user UUID', async () => {
        const targetId = '00000000-0000-4000-8000-000000000002';
        mocks.findUser.mockResolvedValue({
            id: targetId,
            handle: 'target@social.example',
            isLocalAccount: true,
        });

        const request = reportRequest(targetId);
        const response = await POST(request);

        expect(response.status).toBe(200);
        expect(requireSignedAction).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'report' }),
            'report',
        );
        expect(db.insert).toHaveBeenCalledWith({});
        expect(mocks.insertValues).toHaveBeenCalledWith(expect.objectContaining({
            reporterId: reporter.id,
            targetType: 'user',
            targetId,
            reason: 'Harassment from this account',
            status: 'open',
        }));
    });

    it('preserves a canonical remote account address when no cache row exists', async () => {
        mocks.findUser.mockResolvedValue(null);

        const response = await POST(reportRequest('RemoteUser@Remote.Example'));

        expect(response.status).toBe(200);
        expect(mocks.findUser).toHaveBeenCalledWith({
            where: { handle: 'remoteuser@remote.example' },
        });
        expect(mocks.insertValues).toHaveBeenCalledWith(expect.objectContaining({
            targetType: 'user',
            targetId: 'remoteuser@remote.example',
        }));
    });
});
