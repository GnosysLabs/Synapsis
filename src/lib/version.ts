import packageJson from '../../package.json';

const DEFAULT_IMAGE_REPO = 'ghcr.io/gnosyslabs/synapsis';
const VERSION_CACHE_TTL_MS = 5 * 60 * 1000;

export interface BuildInfo {
  version: string;
  commit: string | null;
  buildDate: string | null;
  githubUrl: string | null;
  imageDigest: string | null;
  imageRepo: string;
  sourceRepo: string;
}

type CachedLatest = {
  expiresAt: number;
  value: PublishedBuildInfo | null;
};

export interface PublishedBuildInfo extends BuildInfo {
  tag: string;
}

let latestVersionCache: CachedLatest | null = null;

function normalizeImageRepo(value: string): string {
  if (!value) {
    return DEFAULT_IMAGE_REPO;
  }

  return value.startsWith('ghcr.io/') ? value : `ghcr.io/${value}`;
}

function imageRepoPath(value: string): string {
  return normalizeImageRepo(value).replace(/^ghcr\.io\//, '');
}

function buildGithubUrl(sourceRepo: string, commit: string | null): string | null {
  if (!commit || !sourceRepo) {
    return null;
  }

  return `${sourceRepo.replace(/\/$/, '')}/commit/${commit}`;
}

export function getCurrentBuildInfo(): BuildInfo {
  const sourceRepo = process.env.APP_SOURCE_REPO || 'https://github.com/GnosysLabs/Synapsis';
  const version = process.env.APP_VERSION || packageJson.version || 'dev';
  const commit = process.env.APP_COMMIT || null;
  const buildDate = process.env.APP_BUILD_DATE || null;
  const imageDigest = process.env.APP_IMAGE_DIGEST || null;
  const imageRepo = normalizeImageRepo(process.env.APP_IMAGE_REPO || DEFAULT_IMAGE_REPO);
  const githubUrl = process.env.APP_GITHUB_URL || buildGithubUrl(sourceRepo, commit);

  return {
    version,
    commit,
    buildDate,
    githubUrl,
    imageDigest,
    imageRepo,
    sourceRepo,
  };
}

export function parseVersionTuple(version: string): [number, number, number, number] | null {
  const match = /^(\d{4})\.(\d{2})\.(\d{2})\.(\d+)$/.exec(version);
  if (!match) {
    return null;
  }

  return [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    Number(match[4]),
  ];
}

export function compareBuildVersions(a: string, b: string): number {
  const aTuple = parseVersionTuple(a);
  const bTuple = parseVersionTuple(b);

  if (!aTuple && !bTuple) {
    return a.localeCompare(b);
  }
  if (!aTuple) {
    return -1;
  }
  if (!bTuple) {
    return 1;
  }

  for (let i = 0; i < aTuple.length; i += 1) {
    if (aTuple[i] !== bTuple[i]) {
      return aTuple[i] - bTuple[i];
    }
  }

  return 0;
}

async function fetchGhcrToken(repoPath: string): Promise<string | null> {
  const tokenResponse = await fetch(`https://ghcr.io/token?scope=repository:${repoPath}:pull`, {
    cache: 'no-store',
  });

  if (!tokenResponse.ok) {
    return null;
  }

  const tokenData = await tokenResponse.json();
  return tokenData.token || null;
}

async function fetchRegistryJson(
  repoPath: string,
  reference: string,
  accept: string,
  token: string
) {
  const response = await fetch(`https://ghcr.io/v2/${repoPath}/manifests/${reference}`, {
    headers: {
      Accept: accept,
      Authorization: `Bearer ${token}`,
    },
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new Error(`Registry request failed with ${response.status}`);
  }

  return {
    digest: response.headers.get('docker-content-digest'),
    body: await response.json(),
  };
}

async function fetchRegistryBlob(repoPath: string, digest: string, token: string) {
  const response = await fetch(`https://ghcr.io/v2/${repoPath}/blobs/${digest}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new Error(`Registry blob request failed with ${response.status}`);
  }

  return response.json();
}

async function loadLatestPublishedBuild(): Promise<PublishedBuildInfo | null> {
  const current = getCurrentBuildInfo();
  const repoPath = imageRepoPath(current.imageRepo);
  const token = await fetchGhcrToken(repoPath);

  if (!token) {
    return null;
  }

  const manifestAccept = [
    'application/vnd.oci.image.index.v1+json',
    'application/vnd.docker.distribution.manifest.list.v2+json',
    'application/vnd.oci.image.manifest.v1+json',
    'application/vnd.docker.distribution.manifest.v2+json',
  ].join(', ');

  const latestManifest = await fetchRegistryJson(repoPath, 'latest', manifestAccept, token);
  const latestBody = latestManifest.body;

  let configDigest: string | undefined;

  if (Array.isArray(latestBody.manifests)) {
    const platformManifest =
      latestBody.manifests.find(
        (manifest: any) =>
          manifest.platform?.os === 'linux' && manifest.platform?.architecture === 'amd64'
      ) ||
      latestBody.manifests.find((manifest: any) => manifest.platform?.os && manifest.platform?.architecture);

    if (!platformManifest?.digest) {
      return null;
    }

    const platformManifestResponse = await fetchRegistryJson(repoPath, platformManifest.digest, manifestAccept, token);
    configDigest = platformManifestResponse.body?.config?.digest;
  } else {
    configDigest = latestBody?.config?.digest;
  }

  if (!configDigest) {
    return null;
  }

  const configBlob = await fetchRegistryBlob(repoPath, configDigest, token);
  const labels = configBlob?.config?.Labels || {};
  const sourceRepo = labels['org.opencontainers.image.source'] || current.sourceRepo;
  const commit = labels['org.opencontainers.image.revision'] || null;
  const version = labels['org.opencontainers.image.version'] || null;

  if (!version) {
    return null;
  }

  return {
    tag: 'latest',
    version,
    commit,
    buildDate: labels['org.opencontainers.image.created'] || null,
    githubUrl: buildGithubUrl(sourceRepo, commit),
    imageDigest: latestManifest.digest || null,
    imageRepo: current.imageRepo,
    sourceRepo,
  };
}

export async function getLatestPublishedBuild(): Promise<PublishedBuildInfo | null> {
  if (latestVersionCache && latestVersionCache.expiresAt > Date.now()) {
    return latestVersionCache.value;
  }

  try {
    const latest = await loadLatestPublishedBuild();
    latestVersionCache = {
      expiresAt: Date.now() + VERSION_CACHE_TTL_MS,
      value: latest,
    };
    return latest;
  } catch (error) {
    console.error('[Version] Failed to fetch latest published build:', error);
    latestVersionCache = {
      expiresAt: Date.now() + VERSION_CACHE_TTL_MS,
      value: null,
    };
    return null;
  }
}
