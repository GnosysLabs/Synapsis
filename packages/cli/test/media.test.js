import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { uploadMediaFile } from '../src/media.js';
import { generateCredentialKeyPair } from '../src/signing.js';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

test('uses signed node endpoints around a direct Stuffbox media upload', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'synapsis-cli-media-'));
  const path = join(directory, 'cover.png');
  await writeFile(path, Buffer.from('png-bytes'));
  const keys = await generateCredentialKeyPair();
  const profile = {
    nodeUrl: 'https://social.example',
    credentialId: 'credential-1',
    privateKey: keys.privateKey,
  };
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/api/media/stuffbox/uploads')) {
      const envelope = JSON.parse(init.body);
      assert.equal(envelope.action, 'media_upload_start');
      assert.equal(envelope.data.mimeType, 'image/png');
      assert.equal(envelope.data.size, 9);
      return jsonResponse({ id: 'upload-1', uploadUrl: 'https://stuffbox.example/direct', requiredHeaders: {} }, 201);
    }
    if (String(url) === 'https://stuffbox.example/direct') {
      assert.equal(init.method, 'PUT');
      assert.equal(init.headers['Content-Type'], 'image/png');
      assert.deepEqual(Buffer.from(init.body), Buffer.from('png-bytes'));
      return new Response('', { status: 200 });
    }
    const envelope = JSON.parse(init.body);
    assert.equal(envelope.action, 'media_upload_complete');
    assert.deepEqual(envelope.data, { uploadId: 'upload-1', alt: 'A cover' });
    return jsonResponse({ media: { id: 'media-1', url: 'https://cdn.example/cover.png', altText: 'A cover' } });
  };

  const uploaded = await uploadMediaFile(profile, { path, alt: 'A cover' }, { fetchImpl });
  assert.equal(uploaded.id, 'media-1');
  assert.equal(calls.length, 3);
});
