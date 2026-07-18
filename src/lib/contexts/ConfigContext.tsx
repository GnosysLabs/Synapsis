'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState, ReactNode } from 'react';
import { shouldFailClosedBeforeConfigRefresh } from '@/lib/node/config-refresh-policy';

const NODE_CONFIG_SYNC_CHANNEL = 'synapsis-node-config';
const NODE_CONFIG_STORAGE_KEY = 'synapsis:node-config-changed';
const NODE_CONFIG_REFRESH_MS = 30_000;

interface RuntimeConfig {
  domain: string;
  isNsfw: boolean;
  classificationKnown: boolean;
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
  const requestInFlightRef = useRef(false);
  const requestGenerationRef = useRef(0);
  const activeControllerRef = useRef<AbortController | null>(null);

  const broadcastConfigChange = useCallback(() => {
    if (typeof window === 'undefined') return;
    const marker = `${Date.now()}:${Math.random().toString(36).slice(2)}`;
    if (typeof BroadcastChannel !== 'undefined') {
      const channel = new BroadcastChannel(NODE_CONFIG_SYNC_CHANNEL);
      channel.postMessage(marker);
      channel.close();
      return;
    }
    try {
      window.localStorage.setItem(NODE_CONFIG_STORAGE_KEY, marker);
    } catch {
      // Focus and periodic refresh remain available when storage is blocked.
    }
  }, []);

  const setNodeNsfw = useCallback((isNsfw: boolean) => {
    setConfig((current) => current
      ? { ...current, isNsfw, classificationKnown: true }
      : current);
    broadcastConfigChange();
  }, [broadcastConfigChange]);

  const refreshConfig = useCallback(async (failClosedWhileRefreshing = false) => {
    if (requestInFlightRef.current && !failClosedWhileRefreshing) return;
    const generation = ++requestGenerationRef.current;
    activeControllerRef.current?.abort();
    if (failClosedWhileRefreshing) {
      setConfig((current) => ({
        domain: current?.domain || process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:43821',
        isNsfw: true,
        classificationKnown: false,
      }));
    }
    const controller = new AbortController();
    activeControllerRef.current = controller;
    requestInFlightRef.current = true;
    try {
      const res = await fetch('/api/config', {
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Runtime config returned ${res.status}`);
      const data = await res.json();
      if (generation !== requestGenerationRef.current) return;
      setConfig({
        domain: data.domain || 'localhost:43821',
        isNsfw: data.isNsfw === true,
        classificationKnown: data.classificationKnown === true,
      });
    } catch {
      if (generation !== requestGenerationRef.current) return;
      // A stale "safe" classification must never keep content exposed. Network
      // or storage failures transition the client to the restricted state.
      setConfig({
        domain: process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:43821',
        isNsfw: true,
        classificationKnown: false,
      });
    } finally {
      if (generation === requestGenerationRef.current) {
        activeControllerRef.current = null;
        requestInFlightRef.current = false;
        setIsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void refreshConfig();
    const periodicRefresh = () => void refreshConfig(
      shouldFailClosedBeforeConfigRefresh('periodic')
    );
    const secureRefresh = () => void refreshConfig(
      shouldFailClosedBeforeConfigRefresh('sync')
    );
    const focusRefresh = () => void refreshConfig(
      shouldFailClosedBeforeConfigRefresh('focus')
    );
    const interval = window.setInterval(periodicRefresh, NODE_CONFIG_REFRESH_MS);
    const channel = typeof BroadcastChannel !== 'undefined'
      ? new BroadcastChannel(NODE_CONFIG_SYNC_CHANNEL)
      : null;
    channel?.addEventListener('message', secureRefresh);
    const onStorage = (event: StorageEvent) => {
      if (event.key === NODE_CONFIG_STORAGE_KEY) secureRefresh();
    };
    window.addEventListener('storage', onStorage);
    // Refresh in the background when returning to the tab. A focus event does
    // not mean the node classification changed, so invalidating the current
    // classification here needlessly remounts and reloads every feed.
    window.addEventListener('focus', focusRefresh);

    return () => {
      window.clearInterval(interval);
      activeControllerRef.current?.abort();
      channel?.removeEventListener('message', secureRefresh);
      channel?.close();
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('focus', focusRefresh);
    };
  }, [refreshConfig]);

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
