import { z } from 'zod';
import { isPublicSwarmDomain } from '@/lib/swarm/node-domain';

const localHandlePattern = /^[a-zA-Z0-9_]{3,30}$/;
const hostnameLabel = '[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?';
const nodeDomainPattern = `(?:localhost|127\\.0\\.0\\.1|${hostnameLabel}(?:\\.${hostnameLabel})+)(?::\\d{1,5})?`;
const federatedHandlePattern = new RegExp(`^[a-zA-Z0-9_]{3,30}(?:@${nodeDomainPattern})?$`);
const accountAddressPattern = new RegExp(`^[a-zA-Z0-9_]{3,30}@${nodeDomainPattern}$`);
const nodeDomainRegex = new RegExp(`^${nodeDomainPattern}$`);

export const localHandleSchema = z
  .string()
  .min(3)
  .max(30)
  .regex(localHandlePattern, 'Handle must be 3-30 characters, alphanumeric and underscores only');

export const federatedHandleSchema = z
  .string()
  .min(3)
  .max(286)
  .regex(
    federatedHandlePattern,
    'Handle must be a local handle or a federated handle like user@example.com'
  );

/** The only active account identity form used on federation and API DTOs. */
export const accountAddressSchema = z
  .string()
  .min(5)
  .max(286)
  .regex(accountAddressPattern, 'Account address must look like user@example.com');

export const nodeDomainSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(nodeDomainRegex, 'Invalid node domain format');

export const federationWebUrlSchema = z.string().max(4_096).url().refine((value) => {
  const parsed = new URL(value);
  if (parsed.username || parsed.password) return false;
  const developmentLoopback = process.env.NODE_ENV === 'development'
    && parsed.protocol === 'http:'
    && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  return developmentLoopback
    || (parsed.protocol === 'https:' && isPublicSwarmDomain(parsed.hostname));
}, 'Federated URLs must use public HTTPS without credentials');

const DEFAULT_STUFFBOX_MEDIA_ORIGIN = 'https://stuffbox.xyz';

function trustedFederationMediaOrigins(configuredOrigins?: string): URL[] {
  const configured = [
    DEFAULT_STUFFBOX_MEDIA_ORIGIN,
    ...(configuredOrigins?.split(',') ?? []),
  ];

  return configured.flatMap((value) => {
    if (!value?.trim()) return [];
    try {
      const parsed = new URL(value.trim());
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return [];
      return [parsed];
    } catch {
      return [];
    }
  });
}

/**
 * A peer-controlled HTTPS URL is not automatically safe to render: loading it
 * would disclose the viewer's IP and request timing to that peer. Production
 * accepts only Stuffbox's standard origin (including its subdomains) and exact
 * operator-configured media origins. Development/test keeps public fixtures
 * usable; the production boundary is exercised explicitly in unit tests.
 */
export function isTrustedFederationMediaUrl(
  value: string,
  policy: { production?: boolean; configuredOrigins?: string } = {},
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }

  if (parsed.username || parsed.password) return false;

  const production = policy.production ?? process.env.NODE_ENV === 'production';
  if (!production) {
    return federationWebUrlSchema.safeParse(value).success;
  }

  if (parsed.protocol !== 'https:') return false;

  const configuredOrigins = policy.configuredOrigins
    ?? process.env.NEXT_PUBLIC_FEDERATION_MEDIA_ORIGINS;
  return trustedFederationMediaOrigins(configuredOrigins).some((trusted) => {
    if (parsed.origin === trusted.origin) return true;
    return trusted.hostname === 'stuffbox.xyz'
      && parsed.protocol === 'https:'
      && parsed.port === ''
      && parsed.hostname.endsWith('.stuffbox.xyz');
  });
}

export const federationMediaUrlSchema = federationWebUrlSchema.refine(
  isTrustedFederationMediaUrl,
  'Federated media must use a trusted Stuffbox or operator-approved CDN origin',
);

export function isValidNodeDomain(value: string): boolean {
  return nodeDomainRegex.test(value);
}
