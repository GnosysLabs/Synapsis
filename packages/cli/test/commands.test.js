import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parsePostArguments, run } from '../src/commands.js';
import { loadConfig, storeProfile } from '../src/config.js';
import { generateCredentialKeyPair } from '../src/signing.js';

function output() {
  let value = '';
  return {
    stream: { write: chunk => { value += chunk; } },
    value: () => value,
  };
}

test('associates alt text with the preceding repeated media option', () => {
  assert.deepEqual(parsePostArguments([
    '--text', 'Hello',
    '--media', '/one.png', '--alt', 'One',
    '--media', '/two.mp4', '--nsfw', '--json',
  ]), {
    text: 'Hello',
    stdin: false,
    nsfw: true,
    json: true,
    profile: null,
    media: [
      { path: '/one.png', alt: 'One' },
      { path: '/two.mp4', alt: null },
    ],
  });
});

test('installs the bundled skill for Codex, Agent Skills, and Claude by default', async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), 'synapsis-cli-skills-'));
  const stdout = output();
  const stderr = output();

  await run(['skill', 'install'], {
    stdout: stdout.stream,
    stderr: stderr.stream,
  }, { homeDirectory });

  for (const agentDirectory of ['.codex', '.agents', '.claude']) {
    const skillPath = join(homeDirectory, agentDirectory, 'skills', 'synapsis-post', 'SKILL.md');
    await access(skillPath);
    assert.match(await readFile(skillPath, 'utf8'), /^---\nname: synapsis-post/m);
    assert.match(stdout.value(), new RegExp(`${agentDirectory.replace('.', '\\.')}/skills/synapsis-post`));
  }
  assert.equal(stderr.value(), '');
});

test('does not let an existing default target block the other agent installs', async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), 'synapsis-cli-skills-'));
  const existing = join(homeDirectory, '.codex', 'skills', 'synapsis-post');
  await mkdir(existing, { recursive: true });
  await writeFile(join(existing, 'custom.txt'), 'keep me');
  const stdout = output();
  const stderr = output();

  await run(['skill', 'install'], {
    stdout: stdout.stream,
    stderr: stderr.stream,
  }, { homeDirectory });

  assert.equal(await readFile(join(existing, 'custom.txt'), 'utf8'), 'keep me');
  await access(join(homeDirectory, '.agents', 'skills', 'synapsis-post', 'SKILL.md'));
  await access(join(homeDirectory, '.claude', 'skills', 'synapsis-post', 'SKILL.md'));
  assert.match(stdout.value(), /Skipped existing Synapsis posting skill/);
  assert.equal(stderr.value(), '');
});

test('updates the global CLI before refreshing every bundled skill install', async () => {
  const stdout = output();
  const stderr = output();
  const commands = [];

  await run(['update'], {
    stdout: stdout.stream,
    stderr: stderr.stream,
  }, {
    npmCommand: 'test-npm',
    cliCommand: 'test-node',
    cliArguments: ['/test/synapsis-cli.js'],
    runCommand: async (command, args) => commands.push([command, args]),
  });

  assert.deepEqual(commands, [
    ['test-npm', ['install', '--global', '@gnosyslabs/synapsis-cli@latest']],
    ['test-node', ['/test/synapsis-cli.js', 'skill', 'install', '--force']],
  ]);
  assert.match(stdout.value(), /Updating the Synapsis CLI/);
  assert.match(stdout.value(), /Refreshing the Synapsis agent skill/);
  assert.match(stdout.value(), /up to date/);
  assert.equal(stderr.value(), '');
});

test('connects through browser pairing and stores only the delegated private key locally', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'synapsis-cli-connect-'));
  const environment = { SYNAPSIS_CONFIG_DIR: directory };
  const stdout = output();
  const stderr = output();
  let publicKey;
  const fetchImpl = async (url, init) => {
    if (String(url) === 'https://social.example/api/cli/authorizations') {
      const request = JSON.parse(init.body);
      publicKey = request.publicKey;
      assert.deepEqual(request.scopes, ['posts:write', 'media:write']);
      return new Response(JSON.stringify({
        authorizationRequestId: 'request-1',
        deviceCode: 'device-code',
        verificationUriComplete: 'https://social.example/settings/cli?request=request-1',
        expiresAt: '2099-01-01T00:00:00.000Z',
        interval: 3,
      }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    }
    assert.equal(String(url), 'https://social.example/api/cli/authorizations/request-1');
    assert.equal(init.headers.Authorization, 'Bearer device-code');
    return new Response(JSON.stringify({
      status: 'approved',
      credential: {
        id: 'credential-1',
        name: 'Test agent',
        scopes: ['posts:write', 'media:write'],
        expiresAt: '2099-01-01T00:00:00.000Z',
      },
      account: { did: 'did:key:alice', handle: 'alice', displayName: 'Alice' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  await run([
    'auth', 'connect', 'https://social.example',
    '--name', 'Test agent', '--profile', 'agent', '--no-open',
  ], { stdout: stdout.stream, stderr: stderr.stream }, { environment, fetch: fetchImpl });

  const config = await loadConfig(environment);
  assert.equal(config.currentProfile, 'agent');
  assert.equal(config.profiles.agent.publicKey, publicKey);
  assert.match(config.profiles.agent.privateKey, /^[A-Za-z0-9+/=]+$/);
  assert.equal('password' in config.profiles.agent, false);
  assert.match(stdout.value(), /Key fingerprint:/);
  assert.equal(stderr.value(), '');
});

test('publishes a signed text post and emits the canonical post URL', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'synapsis-cli-command-'));
  const environment = { SYNAPSIS_CONFIG_DIR: directory };
  const keys = await generateCredentialKeyPair();
  await storeProfile('main', {
    nodeUrl: 'https://social.example',
    credentialId: 'credential-1',
    scopes: ['posts:write', 'media:write'],
    expiresAt: '2099-01-01T00:00:00.000Z',
    account: { handle: 'alice' },
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
  }, environment);
  const stdout = output();
  const stderr = output();
  const fetchImpl = async (url, init) => {
    assert.equal(String(url), 'https://social.example/api/posts');
    const envelope = JSON.parse(init.body);
    assert.equal(envelope.action, 'post');
    assert.deepEqual(envelope.data, { content: 'Hello', mediaIds: [], isNsfw: false });
    return new Response(JSON.stringify({ post: { id: 'post-1', content: 'Hello' } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  await run(['post', 'create', '--text', 'Hello', '--json'], {
    stdout: stdout.stream,
    stderr: stderr.stream,
  }, { environment, fetch: fetchImpl });
  const result = JSON.parse(stdout.value());
  assert.equal(result.post.url, 'https://social.example/u/alice/posts/post-1');
  assert.equal(stderr.value(), '');
});
