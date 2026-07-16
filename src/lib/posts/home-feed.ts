export type HomeFeedType = 'node' | 'following' | 'explore';
export type HomeFeedApiType = 'local' | 'home' | 'curated';

export const DEFAULT_HOME_FEED: HomeFeedType = 'node';

export const HOME_FEED_LABELS: Record<HomeFeedType, string> = {
    node: 'Node',
    following: 'Following',
    explore: 'Explore',
};

export const HOME_FEED_API_TYPES: Record<HomeFeedType, HomeFeedApiType> = {
    node: 'local',
    following: 'home',
    explore: 'curated',
};
