export const LIVE_SEARCH_DEBOUNCE_MS = 250;
export const LIVE_SEARCH_MIN_CHARACTERS = 2;

/** Return a searchable term only after enough meaningful characters were typed. */
export function getLiveSearchQuery(value: string): string | null {
    const query = value.trim();
    const meaningfulQuery = query.replace(/^@/, '').trim();
    return meaningfulQuery.length >= LIVE_SEARCH_MIN_CHARACTERS ? query : null;
}
