import { describe, expect, it } from 'vitest';

import {
  getActiveMentionQuery,
  parseMentions,
  replaceMentionQuery,
  tokenizePostContent,
  uniqueMentions,
} from './parser';

describe('mention parser', () => {
  it('parses local, remote, and same-node qualified handles', () => {
    const mentions = parseMentions(
      'Hi @Alice, @bob@remote.example and @carol@local.example.',
      'local.example',
    );

    expect(mentions.map(({ canonicalHandle, isLocal, raw }) => ({ canonicalHandle, isLocal, raw }))).toEqual([
      { canonicalHandle: 'alice', isLocal: true, raw: '@Alice' },
      { canonicalHandle: 'bob@remote.example', isLocal: false, raw: '@bob@remote.example' },
      { canonicalHandle: 'carol', isLocal: true, raw: '@carol@local.example' },
    ]);
  });

  it('rejects email addresses, URL path fragments, malformed domains, and overlong handles', () => {
    const content = [
      'mail alice@example.com',
      'visit https://example.com/@alice',
      '@alice@bad_domain',
      '@abcdefghijklmnopqrstuvwxyzabcde',
      '@alice.example',
    ].join(' ');

    expect(parseMentions(content, 'local.example')).toEqual([]);
  });

  it('keeps sentence punctuation outside the mention range', () => {
    const [mention] = parseMentions('Hello (@alice@remote.example).');
    expect(mention.raw).toBe('@alice@remote.example');
    expect(mention.end).toBe('Hello (@alice@remote.example'.length);
  });

  it('supports the full federated handle length', () => {
    const handle = 'b'.repeat(30);
    expect(parseMentions(`Ask @${handle}`)[0]).toMatchObject({ handle });
  });

  it('deduplicates aliases that resolve to the same local account', () => {
    const mentions = parseMentions('@alice @Alice@local.example @bob@remote.example @bob@remote.example', 'local.example');
    expect(uniqueMentions(mentions).map((mention) => mention.canonicalHandle)).toEqual([
      'alice',
      'bob@remote.example',
    ]);
  });
});

describe('composer mention queries', () => {
  it('finds local and qualified queries at the caret', () => {
    expect(getActiveMentionQuery('hello @ali', 10)).toMatchObject({
      start: 6,
      query: 'ali',
      handleQuery: 'ali',
      domainQuery: null,
    });
    expect(getActiveMentionQuery('@alice@remote.ex', 16)).toMatchObject({
      start: 0,
      query: 'alice@remote.ex',
      handleQuery: 'alice',
      domainQuery: 'remote.ex',
    });
  });

  it('does not activate inside an email address or URL', () => {
    expect(getActiveMentionQuery('alice@example', 13)).toBeNull();
    expect(getActiveMentionQuery('https://example.com/@ali', 24)).toBeNull();
  });

  it('replaces only the active query and returns the next caret position', () => {
    const active = getActiveMentionQuery('Hello @ali friend', 10)!;
    expect(replaceMentionQuery('Hello @ali friend', active, 'alice')).toEqual({
      content: 'Hello @alice friend',
      caret: 12,
    });
  });
});

describe('rich text tokenization', () => {
  it('emits clickable ranges without interpreting mentions inside URLs', () => {
    const tokens = tokenizePostContent('See https://example.com/@alice and ask @bob.', 'local.example');
    expect(tokens.filter((token) => token.type !== 'text').map((token) => ({ type: token.type, value: token.value }))).toEqual([
      { type: 'url', value: 'https://example.com/@alice' },
      { type: 'mention', value: '@bob' },
    ]);
  });
});
