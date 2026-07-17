import assert from 'node:assert/strict';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadConfig, requireProfile, storeProfile } from '../src/config.js';

test('stores profiles in an owner-only credential file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'synapsis-cli-config-'));
  const environment = { SYNAPSIS_CONFIG_DIR: directory };
  await storeProfile('main', {
    nodeUrl: 'https://social.example',
    credentialId: 'credential-1',
    privateKey: 'private',
  }, environment);

  const config = await loadConfig(environment);
  assert.equal(config.currentProfile, 'main');
  assert.equal((await requireProfile(null, environment)).profile.credentialId, 'credential-1');
  if (process.platform !== 'win32') {
    assert.equal((await stat(join(directory, 'credentials.json'))).mode & 0o777, 0o600);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
  }
});

test('rejects unsafe profile names', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'synapsis-cli-config-'));
  const environment = { SYNAPSIS_CONFIG_DIR: directory };
  const profile = { credentialId: 'credential-1' };

  await assert.rejects(storeProfile('__proto__', profile, environment), /Profile names/);
  await assert.rejects(storeProfile('../other-file', profile, environment), /Profile names/);
});
