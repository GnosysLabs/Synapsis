import packageJson from '../../package.json';

export interface BuildInfo {
  version: string;
  commit: string | null;
  buildDate: string | null;
}

export function getCurrentBuildInfo(): BuildInfo {
  return {
    version: process.env.APP_VERSION || packageJson.version || 'dev',
    commit: process.env.APP_COMMIT || null,
    buildDate: process.env.APP_BUILD_DATE || null,
  };
}
