/**
 * Authentication Utilities
 */

import { db, follows, users, sessions } from '@/db';
import { eq, inArray, sql } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import { v4 as uuid } from 'uuid';
import { generateKeyPair } from '@/lib/crypto/keys';
import { didKeyMatchesPublicKey, generateDID } from '@/lib/crypto/did-key';
import { encryptPrivateKey, serializeEncryptedKey } from '@/lib/crypto/private-key';
import { cookies } from 'next/headers';
import { upsertHandleEntries } from '@/lib/federation/handles';
import { registrationDisplayName } from '@/lib/auth/display-name';
import { configuredAdminEmails } from '@/lib/auth/admin-config';
import { resolveSessionTokens } from '@/lib/auth/session-cookie';

const ACTIVE_SESSION_COOKIE_NAME = 'synapsis_session';
const SESSION_COOKIE_NAME = 'synapsis_sessions';
const SESSION_EXPIRY_DAYS = 3650;

type SessionRecord = typeof sessions.$inferSelect & {
    user: typeof users.$inferSelect;
};

export interface AuthAccount {
    id: string;
    handle: string;
    displayName: string | null;
    avatarUrl: string | null;
    did: string;
    publicKey: string;
    privateKeyEncrypted: string | null;
    email: string | null;
    isNsfw: boolean;
    nsfwEnabled: boolean;
    ageVerifiedAt: string | null;
    isActive: boolean;
}

function parseSessionCookie(value: string | undefined): string[] {
    if (!value) {
        return [];
    }

    return value
        .split(',')
        .map(token => token.trim())
        .filter(Boolean);
}

async function readSessionState() {
    const cookieStore = await cookies();
    const activeToken = cookieStore.get(ACTIVE_SESSION_COOKIE_NAME)?.value ?? null;
    const listedTokens = parseSessionCookie(cookieStore.get(SESSION_COOKIE_NAME)?.value);

    // The active-session cookie is sufficient proof of possession on its own.
    // Keep it in the lookup set even when an older client, proxy, or browser has
    // dropped/staled the companion multi-account cookie. Otherwise a successful
    // login can be immediately treated as anonymous on the next /auth/me call.
    const tokens = resolveSessionTokens(activeToken, listedTokens);

    return {
        cookieStore,
        activeToken,
        tokens,
    };
}

async function writeSessionState(tokens: string[], activeToken?: string | null) {
    const cookieStore = await cookies();
    const dedupedTokens = [...new Set(tokens.filter(Boolean))];

    if (dedupedTokens.length === 0) {
        cookieStore.delete(ACTIVE_SESSION_COOKIE_NAME);
        cookieStore.delete(SESSION_COOKIE_NAME);
        return;
    }

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + SESSION_EXPIRY_DAYS);

    const nextActiveToken = activeToken && dedupedTokens.includes(activeToken)
        ? activeToken
        : dedupedTokens[0];

    const cookieOptions = {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax' as const,
        expires: expiresAt,
        path: '/',
    };

    cookieStore.set(ACTIVE_SESSION_COOKIE_NAME, nextActiveToken, cookieOptions);
    cookieStore.set(SESSION_COOKIE_NAME, dedupedTokens.join(','), cookieOptions);
}

async function loadSessionsByTokens(tokens: string[]): Promise<SessionRecord[]> {
    const uniqueTokens = [...new Set(tokens.filter(Boolean))];
    if (uniqueTokens.length === 0) {
        return [];
    }

    const sessionRecords = await db.query.sessions.findMany({
        where: { token: { in: uniqueTokens } },
        with: {
            user: true,
        },
    });

    const sessionMap = new Map(sessionRecords.map(session => [session.token, session]));
    return uniqueTokens
        .map(token => sessionMap.get(token))
        .filter((session): session is SessionRecord => Boolean(session));
}

function toAuthAccount(session: SessionRecord, activeToken: string | null): AuthAccount {
    return {
        id: session.user.id,
        handle: session.user.handle,
        displayName: session.user.displayName,
        avatarUrl: session.user.avatarUrl,
        did: session.user.did,
        publicKey: session.user.publicKey,
        privateKeyEncrypted: session.user.privateKeyEncrypted,
        email: session.user.email,
        isNsfw: session.user.isNsfw,
        nsfwEnabled: session.user.nsfwEnabled,
        ageVerifiedAt: session.user.ageVerifiedAt?.toISOString() || null,
        isActive: session.token === activeToken,
    };
}

/**
 * Hash a password
 */
export async function hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, 12);
}

/**
 * Verify a password against a hash
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
    return bcrypt.compare(password, hash);
}

export { generateDID } from '@/lib/crypto/did-key';

/**
 * Generate legacy DID format (for backward compatibility)
 * @deprecated Use generateDID() instead
 */
export function generateLegacyDID(): string {
    return `did:synapsis:${uuid().replace(/-/g, '')}`;
}

/**
 * Create a new session for a user
 */
export async function createSession(userId: string): Promise<string> {
    const { tokens } = await readSessionState();
    const existingSessions = await loadSessionsByTokens(tokens);
    const existingUserTokens = existingSessions
        .filter(session => session.userId === userId)
        .map(session => session.token);

    if (existingUserTokens.length > 0) {
        await db.delete(sessions).where(inArray(sessions.token, existingUserTokens));
    }

    const token = uuid();
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + SESSION_EXPIRY_DAYS);

    await db.insert(sessions).values({
        userId,
        token,
        expiresAt,
    });

    const filteredTokens = tokens.filter(existingToken => !existingUserTokens.includes(existingToken));
    await writeSessionState([token, ...filteredTokens], token);

    return token;
}

/**
 * Get the current session from cookies
 */
export async function getSession(): Promise<{ user: typeof users.$inferSelect } | null> {
    const { activeToken, tokens } = await readSessionState();
    const sessionRecords = await loadSessionsByTokens(tokens);

    if (sessionRecords.length === 0) {
        await writeSessionState([], null);
        return null;
    }

    const activeSession = sessionRecords.find(session => session.token === activeToken) ?? sessionRecords[0];
    await writeSessionState(sessionRecords.map(session => session.token), activeSession.token);

    return { user: activeSession.user };
}

export async function getSessionAccounts(): Promise<AuthAccount[]> {
    const { activeToken, tokens } = await readSessionState();
    const sessionRecords = await loadSessionsByTokens(tokens);

    if (sessionRecords.length === 0) {
        await writeSessionState([], null);
        return [];
    }

    const resolvedActiveToken = sessionRecords.some(session => session.token === activeToken)
        ? activeToken
        : sessionRecords[0].token;

    await writeSessionState(sessionRecords.map(session => session.token), resolvedActiveToken);

    return sessionRecords.map(session => toAuthAccount(session, resolvedActiveToken));
}

export async function switchSession(userId: string): Promise<{ user: typeof users.$inferSelect }> {
    const { tokens } = await readSessionState();
    const sessionRecords = await loadSessionsByTokens(tokens);
    const matchingSession = sessionRecords.find(session => session.user.id === userId);

    if (!matchingSession) {
        throw new Error('Session not found');
    }

    await writeSessionState(sessionRecords.map(session => session.token), matchingSession.token);

    return { user: matchingSession.user };
}

/**
 * Get current user or throw if not authenticated
 */
export async function requireAuth(): Promise<typeof users.$inferSelect> {
    const session = await getSession();

    if (!session) {
        throw new Error('Authentication required');
    }

    return session.user;
}

/**
 * Destroy the current session
 */
export async function destroySession(userId?: string): Promise<void> {
    const { activeToken, tokens } = await readSessionState();
    const sessionRecords = await loadSessionsByTokens(tokens);

    if (sessionRecords.length === 0) {
        await writeSessionState([], null);
        return;
    }

    const targetSession = userId
        ? sessionRecords.find(session => session.user.id === userId)
        : sessionRecords.find(session => session.token === activeToken) ?? sessionRecords[0];

    if (!targetSession) {
        return;
    }

    await db.delete(sessions).where(eq(sessions.token, targetSession.token));

    const remainingSessions = sessionRecords.filter(session => session.token !== targetSession.token);
    const nextActiveToken = targetSession.token === activeToken
        ? remainingSessions[0]?.token ?? null
        : activeToken;

    await writeSessionState(remainingSessions.map(session => session.token), nextActiveToken);
}

/**
 * Register a new user
 */
export async function registerUser(
    handle: string,
    email: string,
    password: string,
    displayName?: string
): Promise<typeof users.$inferSelect> {
    // Validate handle format
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(handle)) {
        throw new Error('Handle must be 3-20 characters, alphanumeric and underscores only');
    }

    // Check if handle is taken
    const existingHandle = await db.query.users.findFirst({
        where: { handle: handle.toLowerCase() },
    });

    if (existingHandle) {
        throw new Error('Handle is already taken');
    }

    // Check if email is taken
    const existingEmail = await db.query.users.findFirst({
        where: { email: email.toLowerCase() },
    });

    if (existingEmail) {
        throw new Error('Email is already registered');
    }

    // Generate cryptographic keys
    const { publicKey, privateKey } = await generateKeyPair();

    // Encrypt the private key with user's password before storing
    const encryptedPrivateKey = encryptPrivateKey(privateKey, password);

    // Create the user with did:key format (public key encoded in DID)
    const did = generateDID(publicKey);
    const passwordHash = await hashPassword(password);

    const nodeDomain = process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:43821';

    const adminEmails = configuredAdminEmails();
    const adminUsers = adminEmails.length > 0
        ? (await db.query.users.findMany({
            where: { email: { in: adminEmails } },
        })).filter((admin) => !admin.isSuspended)
        : [];

    const user = await db.transaction(async (tx) => {
        const [createdUser] = await tx.insert(users).values({
            did,
            handle: handle.toLowerCase(),
            email: email.toLowerCase(),
            passwordHash,
            displayName: registrationDisplayName(handle, email, displayName),
            publicKey,
            privateKeyEncrypted: serializeEncryptedKey(encryptedPrivateKey),
            followingCount: adminUsers.length,
        }).returning();

        if (adminUsers.length > 0) {
            await tx.insert(follows).values(adminUsers.map((admin) => ({
                followerId: createdUser.id,
                followingId: admin.id,
            })));

            await tx.update(users)
                .set({ followersCount: sql`${users.followersCount} + 1` })
                .where(inArray(users.id, adminUsers.map((admin) => admin.id)));
        }

        return createdUser;
    });

    await upsertHandleEntries([{
        handle: user.handle,
        did: user.did,
        nodeDomain,
        updatedAt: new Date().toISOString(),
    }], { authoritativeDomain: nodeDomain, allowIdentityChange: true });

    return user;
}

/**
 * Authenticate a user with email and password
 */
export async function authenticateUser(
    email: string,
    password: string
): Promise<typeof users.$inferSelect> {
    const user = await db.query.users.findFirst({
        where: { email: email.toLowerCase() },
    });

    if (!user || !user.passwordHash) {
        throw new Error('Invalid email or password');
    }

    const isValid = await verifyPassword(password, user.passwordHash);

    if (!isValid) {
        throw new Error('Invalid email or password');
    }

    // Check if private key needs to be encrypted (migration from plaintext)
    if (user.privateKeyEncrypted && !isEncryptedPrivateKeyStored(user.privateKeyEncrypted)) {
        // Private key is stored in plaintext - encrypt it now
        console.log(`[Auth] Encrypting private key for user ${user.handle}`);
        const encryptedPrivateKey = encryptPrivateKey(user.privateKeyEncrypted, password);
        await db.update(users)
            .set({ privateKeyEncrypted: serializeEncryptedKey(encryptedPrivateKey) })
            .where(eq(users.id, user.id));

        // Update local object
        user.privateKeyEncrypted = serializeEncryptedKey(encryptedPrivateKey);
    }

    // MIGRATION: Check if user has legacy RSA key (upgrade to ECDSA P-256)
    // RSA 2048 SPKI PEM is ~450 chars, ECDSA P-256 is ~178 chars.
    if (user.publicKey.length > 300) {
        console.log(`[Auth] Migrating user ${user.handle} from RSA to ECDSA P-256`);

        // Generate new ECDSA key pair
        const { publicKey, privateKey } = await generateKeyPair();

        // Encrypt new private key
        const encryptedPrivateKey = encryptPrivateKey(privateKey, password);

        // Update DB
        await db.update(users)
            .set({
                publicKey: publicKey,
                privateKeyEncrypted: serializeEncryptedKey(encryptedPrivateKey)
            })
            .where(eq(users.id, user.id));

        // Update local user object to return new keys
        user.publicKey = publicKey;
        user.privateKeyEncrypted = serializeEncryptedKey(encryptedPrivateKey);
    }

    // Older login migrations rotated an RSA signing key without rotating the
    // self-certifying did:key identifier. Repair that mismatch transparently so
    // clients can verify the current account key from the DID itself.
    if (user.did.startsWith('did:key:') && !didKeyMatchesPublicKey(user.did, user.publicKey)) {
        const expectedDid = generateDID(user.publicKey);
        if (user.did !== expectedDid) {
            await db.update(users)
                .set({ did: expectedDid, updatedAt: new Date() })
                .where(eq(users.id, user.id));
            user.did = expectedDid;

            await upsertHandleEntries([{
                handle: user.handle,
                did: expectedDid,
                nodeDomain: process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:43821',
                updatedAt: new Date().toISOString(),
            }], {
                authoritativeDomain: process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:43821',
                allowIdentityChange: true,
            });
        }
    }

    return user;
}

/**
 * Check if stored private key is encrypted (vs plaintext PEM)
 */
function isEncryptedPrivateKeyStored(value: string): boolean {
    if (!value) return false;
    // Plaintext PEM keys start with -----BEGIN
    if (value.startsWith('-----BEGIN')) return false;
    // Try to parse as JSON
    try {
        const parsed = JSON.parse(value);
        return parsed.encrypted && parsed.salt && parsed.iv;
    } catch {
        return false;
    }
}
