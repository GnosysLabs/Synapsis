import { z } from 'zod';

const nullableCoverUrlSchema = z.union([
  z.string().url().max(2048),
  z.literal(''),
  z.null(),
]).transform((value) => value || null);

const collectionFieldsSchema = z.object({
  title: z.string().trim().min(1).max(80),
  description: z.string().trim().max(240).nullable().optional()
    .transform((value) => value || null),
  coverUrl: nullableCoverUrlSchema.optional().transform((value) => value ?? null),
});

export const createCollectionActionDataSchema = collectionFieldsSchema.extend({
  handle: z.string().trim().min(1).max(320),
  postIds: z.array(z.string().uuid()).max(500).optional().default([]),
});

export const updateCollectionActionDataSchema = collectionFieldsSchema.extend({
  handle: z.string().trim().min(1).max(320),
  collectionId: z.string().uuid(),
});

export const deleteCollectionActionDataSchema = z.object({
  handle: z.string().trim().min(1).max(320),
  collectionId: z.string().uuid(),
});

export const updatePostCollectionsActionDataSchema = z.object({
  postId: z.string().uuid(),
  collectionIds: z.array(z.string().uuid()).max(200),
});
