let cachedConfig: { domain: string } | null = null;
let configPromise: Promise<{ domain: string }> | null = null;

export async function getRuntimeConfig() {
  if (cachedConfig) return cachedConfig;
  if (configPromise) return configPromise;

  configPromise = fetch('/api/config')
    .then((res) => res.json())
    .then((data) => {
      cachedConfig = {
        domain: data.domain || 'localhost:43821',
      };
      return cachedConfig;
    })
    .catch(() => {
      cachedConfig = {
        domain: process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:43821',
      };
      return cachedConfig;
    });

  return configPromise;
}

export function getDomain(): string {
  return cachedConfig?.domain || process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:43821';
}

export function clearCachedConfig() {
  cachedConfig = null;
  configPromise = null;
}
