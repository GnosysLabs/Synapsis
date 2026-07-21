export type HomeFeedType = 'forYou' | 'node' | 'following';
export type HomeFeedApiType = 'for-you' | 'local' | 'home';

export const DEFAULT_HOME_FEED: HomeFeedType = 'forYou';
export const ANONYMOUS_HOME_FEED: HomeFeedType = 'node';

export const HOME_FEED_LABELS: Record<HomeFeedType, string> = {
    forYou: 'For You',
    node: 'Node',
    following: 'Following',
};

export const HOME_FEED_API_TYPES: Record<HomeFeedType, HomeFeedApiType> = {
    forYou: 'for-you',
    node: 'local',
    following: 'home',
};

export const ANONYMOUS_APP_DESTINATION = '/';
