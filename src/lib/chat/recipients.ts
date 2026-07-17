export interface ChatRecipient {
    handle: string;
    displayName: string | null;
    avatarUrl: string | null;
    isRemote?: boolean;
    nodeDomain?: string | null;
    isNsfw?: boolean;
    nodeIsNsfw?: boolean;
}

function asRecipient(value: unknown): ChatRecipient | null {
    if (!value || typeof value !== 'object') return null;
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.handle !== 'string' || !candidate.handle.trim()) return null;
    return {
        handle: candidate.handle.trim(),
        displayName: typeof candidate.displayName === 'string' ? candidate.displayName : null,
        avatarUrl: typeof candidate.avatarUrl === 'string' ? candidate.avatarUrl : null,
        isRemote: candidate.isRemote === true,
        ...(typeof candidate.nodeDomain === 'string' ? { nodeDomain: candidate.nodeDomain } : {}),
        ...(typeof candidate.isNsfw === 'boolean' ? { isNsfw: candidate.isNsfw } : {}),
        ...(typeof candidate.nodeIsNsfw === 'boolean' ? { nodeIsNsfw: candidate.nodeIsNsfw } : {}),
    };
}

export function uniqueChatRecipients(
    values: unknown,
    excludedHandle?: string | null,
): ChatRecipient[] {
    if (!Array.isArray(values)) return [];
    const excluded = excludedHandle?.replace(/^@/, '').toLowerCase();
    const seen = new Set<string>();
    const recipients: ChatRecipient[] = [];

    for (const value of values) {
        const recipient = asRecipient(value);
        if (!recipient) continue;
        const key = recipient.handle.replace(/^@/, '').toLowerCase();
        if (key === excluded || seen.has(key)) continue;
        seen.add(key);
        recipients.push(recipient);
    }

    return recipients;
}

export function recentChatRecipients(
    conversations: unknown,
    excludedHandle?: string | null,
): ChatRecipient[] {
    if (!Array.isArray(conversations)) return [];
    return uniqueChatRecipients(
        conversations.map((conversation) => (
            conversation && typeof conversation === 'object'
                ? (conversation as Record<string, unknown>).participant2
                : null
        )),
        excludedHandle,
    );
}

export function buildChatShareHref(recipientHandle: string, sharedUrl: string): string {
    const search = new URLSearchParams({
        compose: recipientHandle.replace(/^@/, ''),
        share: sharedUrl,
    });
    return `/chat?${search.toString()}`;
}

export function buildChatShareContinuationHref(sharedUrl: string | null): string {
    if (!sharedUrl) return '/chat';
    return `/chat?${new URLSearchParams({ share: sharedUrl }).toString()}`;
}
