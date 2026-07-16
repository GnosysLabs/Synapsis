export const EXPLORE_FEED_API_TYPE = 'curated';

export const EXPLORE_TABS = [
    { id: 'explore', label: 'Explore' },
    { id: 'users', label: 'Users' },
] as const;

export type ExploreTab = typeof EXPLORE_TABS[number]['id'];
