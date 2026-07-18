import { z } from 'zod';
import { isPublicSwarmDomain } from '@/lib/swarm/node-domain';

const localHandlePattern = /^[a-zA-Z0-9_]{3,30}$/;
const hostnameLabel = '[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?';
const nodeDomainPattern = `(?:localhost|127\\.0\\.0\\.1|${hostnameLabel}(?:\\.${hostnameLabel})+)(?::\\d{1,5})?`;
const federatedHandlePattern = new RegExp(`^[a-zA-Z0-9_]{3,30}(?:@${nodeDomainPattern})?$`);
const nodeDomainRegex = new RegExp(`^${nodeDomainPattern}$`);

export const localHandleSchema = z
  .string()
  .min(3)
  .max(30)
  .regex(localHandlePattern, 'Handle must be 3-30 characters, alphanumeric and underscores only');

export const federatedHandleSchema = z
  .string()
  .min(3)
  .max(255)
  .regex(
    federatedHandlePattern,
    'Handle must be a local handle or a federated handle like user@example.com'
  );

export const nodeDomainSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(nodeDomainRegex, 'Invalid node domain format');

export const federationMediaUrlSchema = z.string().max(4_096).url().refine((value) => {
  const parsed = new URL(value);
  const developmentLoopback = process.env.NODE_ENV === 'development'
    && parsed.protocol === 'http:'
    && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  return developmentLoopback
    || (parsed.protocol === 'https:' && isPublicSwarmDomain(parsed.hostname));
}, 'Federated media must use a public HTTPS URL');

export function isValidNodeDomain(value: string): boolean {
  return nodeDomainRegex.test(value);
}
