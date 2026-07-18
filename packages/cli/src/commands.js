import { spawn } from 'node:child_process';
import { cp, lstat, rm } from 'node:fs/promises';
import { hostname, homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadConfig,
  removeProfile,
  requireProfile,
  selectProfile,
  storeProfile,
} from './config.js';
import { normalizeNodeUrl, requestJson, signedRequest, sleep } from './http.js';
import { uploadMediaFile } from './media.js';
import { generateCredentialKeyPair } from './signing.js';

export const CLI_VERSION = '0.1.2';

const HELP = `Synapsis CLI ${CLI_VERSION}

Usage:
  synapsis auth connect <node-url> [--name <device>] [--profile <name>] [--expires-days <1-365>] [--no-open] [--json]
  synapsis auth status [--json]
  synapsis auth use <profile>
  synapsis auth disconnect [--profile <name>] [--local]
  synapsis post create [--text <content> | --stdin] [--media <path> [--alt <text>]]... [--nsfw] [--profile <name>] [--json]
  synapsis skill install [--path <skills-directory>] [--force]
  synapsis update

Media may be repeated up to four times. Supported files: JPEG, PNG, GIF, WebP,
MP4, WebM, MOV, MP3, M4A, AAC, WAV, OGG, and FLAC.
`;

function write(stream, value) {
  stream.write(value.endsWith('\n') ? value : `${value}\n`);
}

function booleanFlag(args, name) {
  return args.includes(name);
}

function valueFlag(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function unknownFlags(args, valueFlags, booleanFlags) {
  const knownValues = new Set(valueFlags);
  const knownBooleans = new Set(booleanFlags);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith('--')) continue;
    if (knownValues.has(argument)) {
      index += 1;
      continue;
    }
    if (!knownBooleans.has(argument)) throw new Error(`Unknown option: ${argument}`);
  }
}

function positionalArguments(args, valueFlags) {
  const values = [];
  const takingValue = new Set(valueFlags);
  for (let index = 0; index < args.length; index += 1) {
    if (takingValue.has(args[index])) {
      index += 1;
    } else if (!args[index].startsWith('--')) {
      values.push(args[index]);
    }
  }
  return values;
}

export function parsePostArguments(args) {
  const result = {
    text: null,
    stdin: false,
    nsfw: false,
    json: false,
    profile: null,
    media: [],
  };
  const takeValue = (option, index) => {
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${option} requires a value`);
    return value;
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--text') result.text = takeValue(argument, index++);
    else if (argument === '--stdin') result.stdin = true;
    else if (argument === '--nsfw') result.nsfw = true;
    else if (argument === '--json') result.json = true;
    else if (argument === '--profile') result.profile = takeValue(argument, index++);
    else if (argument === '--media') result.media.push({ path: takeValue(argument, index++), alt: null });
    else if (argument === '--alt') {
      if (result.media.length === 0) throw new Error('--alt must follow the media file it describes');
      result.media[result.media.length - 1].alt = takeValue(argument, index++);
    } else {
      throw new Error(`Unknown post option: ${argument}`);
    }
  }
  if (result.stdin && result.text !== null) throw new Error('Use either --text or --stdin, not both');
  if (result.media.length > 4) throw new Error('A Synapsis post can contain at most four media files');
  return result;
}

function defaultOpenUrl(url) {
  let command;
  let args;
  if (process.platform === 'darwin') {
    command = 'open';
    args = [url];
  } else if (process.platform === 'win32') {
    command = 'rundll32';
    args = ['url.dll,FileProtocolHandler', url];
  } else {
    command = 'xdg-open';
    args = [url];
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

function defaultRunCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const reason = signal ? `signal ${signal}` : `exit code ${code}`;
      reject(new Error(`${command} failed with ${reason}`));
    });
  });
}

function formatFingerprint(value) {
  return value.match(/.{1,4}/g)?.join(' ') ?? value;
}

async function readStandardInput(io) {
  if (io.readStdin) return io.readStdin();
  let content = '';
  for await (const chunk of process.stdin) content += chunk;
  return content.replace(/\r?\n$/, '');
}

async function connect(args, io, dependencies) {
  unknownFlags(args, ['--name', '--profile', '--expires-days'], ['--no-open', '--json']);
  const positions = positionalArguments(args, ['--name', '--profile', '--expires-days']);
  if (positions.length !== 1) throw new Error('Usage: synapsis auth connect <node-url>');
  const nodeUrl = normalizeNodeUrl(positions[0]);
  const name = valueFlag(args, '--name') || `Synapsis CLI on ${hostname()}`;
  const requestedProfileName = valueFlag(args, '--profile');
  const lifetimeDays = Number(valueFlag(args, '--expires-days') || 90);
  if (!Number.isInteger(lifetimeDays) || lifetimeDays < 1 || lifetimeDays > 365) {
    throw new Error('--expires-days must be an integer between 1 and 365');
  }
  const json = booleanFlag(args, '--json');
  const keyPair = await generateCredentialKeyPair();
  const authorization = await requestJson(`${nodeUrl}/api/cli/authorizations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      publicKey: keyPair.publicKey,
      scopes: ['posts:write', 'media:write'],
      credentialLifetimeDays: lifetimeDays,
    }),
  }, dependencies.fetch);

  if (json) {
    write(io.stdout, JSON.stringify({
      event: 'authorization_required',
      url: authorization.verificationUriComplete,
      fingerprint: keyPair.fingerprint,
      expiresAt: authorization.expiresAt,
    }));
  } else {
    write(io.stdout, `Approve this CLI in your browser:\n${authorization.verificationUriComplete}\nKey fingerprint: ${formatFingerprint(keyPair.fingerprint)}`);
  }
  if (!booleanFlag(args, '--no-open')) {
    try {
      await (dependencies.openUrl || defaultOpenUrl)(authorization.verificationUriComplete);
    } catch {
      if (!json) write(io.stderr, 'The browser could not be opened automatically; use the URL above.');
    }
  }

  const expiresAt = Date.parse(authorization.expiresAt);
  const interval = Math.max(1, Number(authorization.interval) || 3) * 1000;
  while (Date.now() < expiresAt) {
    const result = await requestJson(
      `${nodeUrl}/api/cli/authorizations/${encodeURIComponent(authorization.authorizationRequestId)}`,
      { headers: { Authorization: `Bearer ${authorization.deviceCode}` } },
      dependencies.fetch,
    );
    if (result.status === 'approved') {
      const profileName = requestedProfileName || `${result.account.handle}@${new URL(nodeUrl).host}`;
      const profile = {
        nodeUrl,
        credentialId: result.credential.id,
        credentialName: result.credential.name,
        scopes: result.credential.scopes,
        expiresAt: result.credential.expiresAt,
        account: result.account,
        publicKey: keyPair.publicKey,
        privateKey: keyPair.privateKey,
        fingerprint: keyPair.fingerprint,
        connectedAt: new Date().toISOString(),
      };
      await storeProfile(profileName, profile, dependencies.environment);
      const output = { profile: profileName, nodeUrl, account: result.account, expiresAt: result.credential.expiresAt };
      write(io.stdout, json ? JSON.stringify({ event: 'connected', ...output }) : `Connected ${profileName} as @${result.account.handle}.`);
      return;
    }
    if (result.status !== 'pending') throw new Error(`Authorization ended with status: ${result.status}`);
    await (dependencies.sleep || sleep)(interval);
  }
  throw new Error('The CLI authorization request expired');
}

async function authStatus(args, io, dependencies) {
  unknownFlags(args, [], ['--json']);
  const config = await loadConfig(dependencies.environment);
  const profiles = Object.entries(config.profiles).map(([name, profile]) => ({
    name,
    current: name === config.currentProfile,
    nodeUrl: profile.nodeUrl,
    handle: profile.account?.handle,
    scopes: profile.scopes,
    expiresAt: profile.expiresAt,
    expired: Date.parse(profile.expiresAt) <= Date.now(),
  }));
  if (booleanFlag(args, '--json')) {
    write(io.stdout, JSON.stringify({ currentProfile: config.currentProfile, profiles }));
    return;
  }
  if (profiles.length === 0) {
    write(io.stdout, 'No Synapsis CLI profiles are connected.');
    return;
  }
  for (const profile of profiles) {
    write(io.stdout, `${profile.current ? '* ' : '  '}${profile.name}  @${profile.handle}  ${profile.nodeUrl}${profile.expired ? '  (expired)' : ''}`);
  }
}

async function authUse(args, io, dependencies) {
  if (args.length !== 1) throw new Error('Usage: synapsis auth use <profile>');
  await selectProfile(args[0], dependencies.environment);
  write(io.stdout, `Using Synapsis profile ${args[0]}.`);
}

async function disconnect(args, io, dependencies) {
  unknownFlags(args, ['--profile'], ['--local', '--json']);
  const selected = await requireProfile(valueFlag(args, '--profile'), dependencies.environment);
  if (!booleanFlag(args, '--local')) {
    await signedRequest(selected.profile, '/api/cli/credentials/revoke', 'cli_revoke_self', {}, dependencies.fetch);
  }
  await removeProfile(selected.name, dependencies.environment);
  const output = { disconnected: selected.name, revoked: !booleanFlag(args, '--local') };
  write(io.stdout, booleanFlag(args, '--json') ? JSON.stringify(output) : `Disconnected ${selected.name}${output.revoked ? ' and revoked its access' : ' locally'}.`);
}

async function createPost(args, io, dependencies) {
  const options = parsePostArguments(args);
  const selected = await requireProfile(options.profile, dependencies.environment);
  if (Date.parse(selected.profile.expiresAt) <= Date.now()) throw new Error(`CLI profile ${selected.name} has expired`);
  if (!selected.profile.scopes.includes('posts:write')) throw new Error(`CLI profile ${selected.name} cannot publish posts`);

  const content = options.stdin ? await readStandardInput(io) : options.text || '';
  if (content.length > 600) throw new Error('Synapsis posts are limited to 600 characters');
  if (!content.trim() && options.media.length === 0) throw new Error('Add text or at least one media file');
  if (options.media.length > 0 && !selected.profile.scopes.includes('media:write')) {
    throw new Error(`CLI profile ${selected.name} cannot upload media`);
  }

  const uploadedMedia = [];
  for (const media of options.media) {
    const uploaded = await uploadMediaFile(selected.profile, media, {
      fetchImpl: dependencies.fetch,
      onProgress: options.json ? undefined : message => write(io.stderr, message),
    });
    uploadedMedia.push(uploaded);
  }

  const result = await signedRequest(selected.profile, '/api/posts', 'post', {
    content,
    mediaIds: uploadedMedia.map(media => media.id),
    isNsfw: options.nsfw,
  }, dependencies.fetch);
  const postUrl = `${selected.profile.nodeUrl}/u/${encodeURIComponent(selected.profile.account.handle)}/posts/${encodeURIComponent(result.post.id)}`;
  const output = {
    success: true,
    post: { id: result.post.id, url: postUrl, content: result.post.content },
    media: uploadedMedia.map(media => ({ id: media.id, url: media.url, altText: media.altText || null })),
  };
  write(io.stdout, options.json ? JSON.stringify(output) : `Published ${postUrl}`);
}

async function skillInstall(args, io, dependencies) {
  unknownFlags(args, ['--path'], ['--force']);
  const requestedSkillsRoot = valueFlag(args, '--path');
  const userHome = dependencies.homeDirectory || homedir();
  const skillsRoots = requestedSkillsRoot ? [requestedSkillsRoot] : [
    join(userHome, '.codex', 'skills'),
    join(userHome, '.agents', 'skills'),
    join(userHome, '.claude', 'skills'),
  ];
  const source = fileURLToPath(new URL('../skill/synapsis-post', import.meta.url));
  const force = booleanFlag(args, '--force');

  for (const skillsRoot of skillsRoots) {
    const destination = join(skillsRoot, 'synapsis-post');
    let exists = false;
    try {
      await lstat(destination);
      exists = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (exists && !force) {
      if (requestedSkillsRoot) {
        throw new Error(`${destination} already exists; pass --force to replace it`);
      }
      write(io.stdout, `Skipped existing Synapsis posting skill at ${destination}; pass --force to replace it`);
      continue;
    }
    if (exists) await rm(destination, { recursive: true, force: true });
    await cp(source, destination, { recursive: true });
    write(io.stdout, `Installed the Synapsis posting skill at ${destination}`);
  }
}

async function update(args, io, dependencies) {
  if (args.length > 0) throw new Error('Usage: synapsis update');

  write(io.stdout, 'Updating the Synapsis CLI...');
  await dependencies.runCommand(dependencies.npmCommand, [
    'install',
    '--global',
    '@gnosyslabs/synapsis-cli@latest',
  ]);

  write(io.stdout, 'Refreshing the Synapsis agent skill...');
  await dependencies.runCommand(dependencies.cliCommand, [
    ...dependencies.cliArguments,
    'skill',
    'install',
    '--force',
  ]);
  write(io.stdout, 'Synapsis CLI and agent skill are up to date.');
}

export async function run(argv, io = process, dependencies = {}) {
  const runtime = {
    fetch: dependencies.fetch || globalThis.fetch,
    environment: dependencies.environment || process.env,
    openUrl: dependencies.openUrl,
    sleep: dependencies.sleep,
    homeDirectory: dependencies.homeDirectory,
    runCommand: dependencies.runCommand || defaultRunCommand,
    npmCommand: dependencies.npmCommand || (process.platform === 'win32' ? 'npm.cmd' : 'npm'),
    cliCommand: dependencies.cliCommand || process.execPath,
    cliArguments: dependencies.cliArguments || [fileURLToPath(new URL('./cli.js', import.meta.url))],
  };
  const [group, command, ...args] = argv;
  if (!group || group === 'help' || group === '--help' || group === '-h') {
    write(io.stdout, HELP);
    return;
  }
  if (group === '--version' || group === '-v' || group === 'version') {
    write(io.stdout, CLI_VERSION);
    return;
  }
  if (group === 'auth' && command === 'connect') return connect(args, io, runtime);
  if (group === 'auth' && command === 'status') return authStatus(args, io, runtime);
  if (group === 'auth' && command === 'use') return authUse(args, io, runtime);
  if (group === 'auth' && command === 'disconnect') return disconnect(args, io, runtime);
  if (group === 'post' && command === 'create') return createPost(args, io, runtime);
  if (group === 'skill' && command === 'install') return skillInstall(args, io, runtime);
  if (group === 'update') return update([command, ...args].filter(value => value !== undefined), io, runtime);
  throw new Error(`Unknown command: ${[group, command].filter(Boolean).join(' ')}\n\n${HELP}`);
}
