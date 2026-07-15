import packageJson from '../../package.json';

export interface BuildInfo {
  version: string;
  commit: string | null;
  commitCount: number | null;
  buildDate: string | null;
}

export function getCurrentBuildInfo(): BuildInfo {
  const parsedCommitCount = Number.parseInt(process.env.APP_COMMIT_COUNT || '', 10);

  return {
    version: process.env.APP_VERSION || packageJson.version || 'dev',
    commit: process.env.APP_COMMIT || null,
    commitCount: Number.isSafeInteger(parsedCommitCount) && parsedCommitCount >= 0
      ? parsedCommitCount
      : null,
    buildDate: process.env.APP_BUILD_DATE || null,
  };
}
