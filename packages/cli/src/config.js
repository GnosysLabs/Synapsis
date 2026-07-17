import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const RESERVED_PROFILE_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

function isValidProfileName(name) {
  return typeof name === 'string'
    && name.length >= 1
    && name.length <= 120
    && !RESERVED_PROFILE_NAMES.has(name)
    && !/[\u0000-\u001f\u007f/\\]/.test(name);
}

function validateProfileName(name) {
  if (!isValidProfileName(name)) {
    throw new Error('Profile names must be 1-120 characters and cannot contain slashes or control characters');
  }
}

function safeProfiles(value) {
  const profiles = Object.create(null);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return profiles;
  for (const [name, profile] of Object.entries(value)) {
    if (isValidProfileName(name) && profile && typeof profile === 'object' && !Array.isArray(profile)) {
      profiles[name] = profile;
    }
  }
  return profiles;
}

export function configDirectory(environment = process.env) {
  if (environment.SYNAPSIS_CONFIG_DIR) return environment.SYNAPSIS_CONFIG_DIR;
  const base = environment.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'synapsis');
}

export function configPath(environment = process.env) {
  return join(configDirectory(environment), 'credentials.json');
}

export async function loadConfig(environment = process.env) {
  try {
    const parsed = JSON.parse(await readFile(configPath(environment), 'utf8'));
    const profiles = safeProfiles(parsed.profiles);
    const currentProfile = isValidProfileName(parsed.currentProfile)
      && Object.hasOwn(profiles, parsed.currentProfile)
      ? parsed.currentProfile
      : null;
    return {
      version: 1,
      currentProfile,
      profiles,
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return { version: 1, currentProfile: null, profiles: {} };
    throw new Error(`Unable to read Synapsis credentials: ${error.message}`);
  }
}

export async function saveConfig(config, environment = process.env) {
  const directory = configDirectory(environment);
  const destination = configPath(environment);
  const temporary = `${destination}.${process.pid}.tmp`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, destination);
  await chmod(destination, 0o600);
}

export async function storeProfile(name, profile, environment = process.env) {
  validateProfileName(name);
  const config = await loadConfig(environment);
  config.profiles[name] = profile;
  config.currentProfile = name;
  await saveConfig(config, environment);
}

export async function requireProfile(name, environment = process.env) {
  if (name !== null && name !== undefined) validateProfileName(name);
  const config = await loadConfig(environment);
  const selected = name || config.currentProfile;
  if (!selected || !Object.hasOwn(config.profiles, selected)) {
    throw new Error('No Synapsis CLI profile is connected. Run `synapsis auth connect <node-url>`.');
  }
  return { name: selected, profile: config.profiles[selected], config };
}

export async function selectProfile(name, environment = process.env) {
  validateProfileName(name);
  const config = await loadConfig(environment);
  if (!Object.hasOwn(config.profiles, name)) throw new Error(`Unknown profile: ${name}`);
  config.currentProfile = name;
  await saveConfig(config, environment);
}

export async function removeProfile(name, environment = process.env) {
  validateProfileName(name);
  const config = await loadConfig(environment);
  if (!Object.hasOwn(config.profiles, name)) return false;
  delete config.profiles[name];
  if (config.currentProfile === name) config.currentProfile = Object.keys(config.profiles)[0] || null;
  await saveConfig(config, environment);
  return true;
}

export async function clearConfigForTests(environment = process.env) {
  await rm(configDirectory(environment), { recursive: true, force: true });
}
