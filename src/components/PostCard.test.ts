import { describe, expect, it } from 'vitest';
import { PostCard } from './PostCard';
import type { Post } from '@/lib/types';

describe('PostCard', () => {
    it('ignores a malformed post without an author instead of crashing the feed', () => {
        const malformedPost = { id: 'orphan-post', author: null } as unknown as Post;

        expect(PostCard({ post: malformedPost })).toBeNull();
    });
});
