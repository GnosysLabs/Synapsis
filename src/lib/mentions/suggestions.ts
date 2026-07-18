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
    return suggestions.filter((suggestion) => {
        const handle = suggestion.handle.toLowerCase();
        if (seen.has(handle)) return false;
        seen.add(handle);
        return true;
    });
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
    const localHandles = new Set(localQueue.map((suggestion) => suggestion.handle.toLowerCase()));
    const remoteQueue = uniqueSuggestions(remote)
        .filter((suggestion) => !localHandles.has(suggestion.handle.toLowerCase()));
    const merged: MentionSuggestion[] = [];
    let localIndex = 0;
    let remoteIndex = 0;

    while (merged.length < limit && (localIndex < localQueue.length || remoteIndex < remoteQueue.length)) {
        if (localIndex < localQueue.length) merged.push(localQueue[localIndex++]);
        if (merged.length < limit && remoteIndex < remoteQueue.length) merged.push(remoteQueue[remoteIndex++]);
    }

    return merged;
}
