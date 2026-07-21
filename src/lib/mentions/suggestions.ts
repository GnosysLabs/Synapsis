import { canonicalAccountAddress } from '@/lib/identity/account-address';

export interface MentionSuggestion {
    handle: string;
    displayName: string | null;
    avatarUrl: string | null;
    isRemote: boolean;
    nodeDomain: string | null;
    isNsfw?: boolean;
    nodeIsNsfw?: boolean;
}

function uniqueSuggestions(suggestions: MentionSuggestion[]): MentionSuggestion[] {
    const seen = new Set<string>();
    const unique: MentionSuggestion[] = [];
    for (const suggestion of suggestions) {
        const handle = canonicalAccountAddress(suggestion.handle, suggestion.nodeDomain);
        if (!handle || seen.has(handle)) continue;
        seen.add(handle);
        unique.push({ ...suggestion, handle });
    }
    return unique;
}

/**
 * Keep local people prominent while guaranteeing that matching swarm users are
 * visible whenever the result limit has room for more than one suggestion.
 */
export function mergeMentionSuggestions(
    local: MentionSuggestion[],
    remote: MentionSuggestion[],
    limit: number,
): MentionSuggestion[] {
    const localQueue = uniqueSuggestions(local);
    const localHandles = new Set(localQueue.map((suggestion) => suggestion.handle));
    const remoteQueue = uniqueSuggestions(remote)
        .filter((suggestion) => !localHandles.has(suggestion.handle));
    const merged: MentionSuggestion[] = [];
    let localIndex = 0;
    let remoteIndex = 0;

    while (merged.length < limit && (localIndex < localQueue.length || remoteIndex < remoteQueue.length)) {
        if (localIndex < localQueue.length) merged.push(localQueue[localIndex++]);
        if (merged.length < limit && remoteIndex < remoteQueue.length) merged.push(remoteQueue[remoteIndex++]);
    }

    return merged;
}
