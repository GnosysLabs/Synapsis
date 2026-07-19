import type { Post } from '@/lib/types';

export interface CollectionSummary {
  id: string;
  title: string;
  description: string | null;
  coverUrl: string | null;
  previewImages: string[];
  postCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CollectionDetail extends CollectionSummary {
  posts: Post[];
}

export interface PostCollectionChoice extends CollectionSummary {
  containsPost: boolean;
}
