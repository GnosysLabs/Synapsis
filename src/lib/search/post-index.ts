import {
  db,
  localPostSearchTerms,
  posts,
  remotePostSearchTerms,
  remotePosts,
} from '@/db';
import { and, eq, gte, lt, notExists } from 'drizzle-orm';

const MAX_TERMS_PER_POST = 64;
const MAX_TERM_LENGTH = 64;
const MAX_SEARCH_CANDIDATES = 1_000;

export function tokenizePostSearch(value: string): string[] {
  return Array.from(new Set(
    value.normalize('NFKC').toLocaleLowerCase().match(/[\p{L}\p{N}_]+/gu) || [],
  )).map((term) => term.slice(0, MAX_TERM_LENGTH)).filter(Boolean).slice(0, MAX_TERMS_PER_POST);
}

export async function indexLocalPostContent(postId: string, content: string): Promise<void> {
  await db.delete(localPostSearchTerms).where(eq(localPostSearchTerms.postId, postId));
  const terms = tokenizePostSearch(content);
  await db.insert(localPostSearchTerms)
    .values((terms.length ? terms : ['']).map((term) => ({ postId, term })))
    .onConflictDoNothing();
}

export async function indexRemotePostContent(postId: string, content: string): Promise<void> {
  await db.delete(remotePostSearchTerms).where(eq(remotePostSearchTerms.postId, postId));
  const terms = tokenizePostSearch(content);
  await db.insert(remotePostSearchTerms)
    .values((terms.length ? terms : ['']).map((term) => ({ postId, term })))
    .onConflictDoNothing();
}

async function candidatesForTerms(
  kind: 'local' | 'remote',
  terms: string[],
): Promise<string[]> {
  const table = kind === 'local' ? localPostSearchTerms : remotePostSearchTerms;
  let intersection: Set<string> | null = null;
  for (const term of terms.slice(0, 10)) {
    const rows = await db.select({ postId: table.postId }).from(table).where(and(
      gte(table.term, term),
      lt(table.term, `${term}\uffff`),
    )).limit(MAX_SEARCH_CANDIDATES);
    const ids = new Set<string>(rows.map((row) => String(row.postId)));
    if (intersection === null) {
      intersection = ids;
    } else {
      const previous: Set<string> = intersection;
      intersection = new Set<string>(Array.from(previous).filter((id: string) => ids.has(id)));
    }
    if (intersection.size === 0) break;
  }
  return Array.from(intersection || []);
}

export async function searchIndexedPostIds(
  kind: 'local' | 'remote',
  query: string,
): Promise<string[]> {
  const terms = tokenizePostSearch(query);
  if (!terms.length) return [];
  return candidatesForTerms(kind, terms);
}

/** Repair a bounded number of rows missed by a crash between post and index writes. */
export async function reconcilePostSearchIndex(batchSize = 100): Promise<number> {
  const boundedBatch = Math.max(1, Math.min(batchSize, 500));
  const [missingLocal, missingRemote] = await Promise.all([
    db.select({ id: posts.id, content: posts.content }).from(posts).where(notExists(
      db.select({ postId: localPostSearchTerms.postId }).from(localPostSearchTerms)
        .where(eq(localPostSearchTerms.postId, posts.id)),
    )).limit(boundedBatch),
    db.select({ id: remotePosts.id, content: remotePosts.content }).from(remotePosts).where(notExists(
      db.select({ postId: remotePostSearchTerms.postId }).from(remotePostSearchTerms)
        .where(eq(remotePostSearchTerms.postId, remotePosts.id)),
    )).limit(boundedBatch),
  ]);
  for (const row of missingLocal) await indexLocalPostContent(row.id, row.content);
  for (const row of missingRemote) await indexRemotePostContent(row.id, row.content);
  return missingLocal.length + missingRemote.length;
}
