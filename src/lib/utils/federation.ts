import { z } from 'zod';

const localHandlePattern = /^[a-zA-Z0-9_]{3,20}$/;
const hostnameLabel = '[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?';
const nodeDomainPattern = `(?:localhost|127\\.0\\.0\\.1|${hostnameLabel}(?:\\.${hostnameLabel})+)(?::\\d{1,5})?`;
const federatedHandlePattern = new RegExp(`^[a-zA-Z0-9_]{3,20}(?:@${nodeDomainPattern})?$`);
const nodeDomainRegex = new RegExp(`^${nodeDomainPattern}$`);

export const localHandleSchema = z
  .string()
  .min(3)
  .max(20)
  .regex(localHandlePattern, 'Handle must be 3-20 characters, alphanumeric and underscores only');

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

export function isValidNodeDomain(value: string): boolean {
  return nodeDomainRegex.test(value);
}
