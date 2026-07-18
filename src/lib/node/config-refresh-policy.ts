export type NodeConfigRefreshTrigger = 'periodic' | 'focus' | 'sync';

/**
 * Cross-context sync signals mean the node classification may have changed,
 * so content must fail closed until the new value arrives. Periodic and focus
 * refreshes are freshness checks and should keep the last known classification
 * while they run.
 */
export function shouldFailClosedBeforeConfigRefresh(trigger: NodeConfigRefreshTrigger): boolean {
    return trigger === 'sync';
}
