'use client';

import { createContext, useCallback, useContext, useEffect, useState, ReactNode } from 'react';

interface RuntimeConfig {
  domain: string;
  isNsfw: boolean;
}

interface ConfigContextType {
  config: RuntimeConfig | null;
  isLoading: boolean;
  setNodeNsfw: (isNsfw: boolean) => void;
}

const ConfigContext = createContext<ConfigContextType>({
  config: null,
  isLoading: true,
  setNodeNsfw: () => { },
});

export function ConfigProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<RuntimeConfig | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const setNodeNsfw = useCallback((isNsfw: boolean) => {
    setConfig((current) => current ? { ...current, isNsfw } : current);
  }, []);

  useEffect(() => {
    // Fetch runtime config on mount
    fetch('/api/config')
      .then((res) => res.json())
      .then((data) => {
        setConfig({
          domain: data.domain || 'localhost:43821',
          isNsfw: data.isNsfw === true,
        });
      })
      .catch(() => {
        // Fallback to build-time value if fetch fails
        setConfig({
          domain: process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:43821',
          isNsfw: false,
        });
      })
      .finally(() => {
        setIsLoading(false);
      });
  }, []);

  return (
    <ConfigContext.Provider value={{ config, isLoading, setNodeNsfw }}>
      {children}
    </ConfigContext.Provider>
  );
}

export function useRuntimeConfig() {
  const context = useContext(ConfigContext);
  if (!context) {
    throw new Error('useRuntimeConfig must be used within a ConfigProvider');
  }
  return context;
}

export function useDomain(): string {
  const { config, isLoading } = useRuntimeConfig();
  // Return runtime domain if loaded, otherwise fall back to build-time value
  if (isLoading || !config) {
    return process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:43821';
  }
  return config.domain;
}
