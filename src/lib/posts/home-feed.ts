export type HomeFeedType = 'following' | 'curated';

export const DEFAULT_HOME_FEED: HomeFeedType = 'curated';

export const HOME_FEED_LABELS: Record<HomeFeedType, string> = {
    following: 'Following',
    curated: 'For You',
};
