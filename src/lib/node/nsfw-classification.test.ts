import { describe, expect, it } from 'vitest';
import {
    matchesNodeDomainConfirmation,
    mergePermanentNodeNsfwClassification,
    resolveNodeNsfwTransition,
} from './nsfw-classification';

describe('permanent adult-only node classification', () => {
    it('requires the configured domain before converting a general-audience node', () => {
        expect(resolveNodeNsfwTransition({
            currentIsNsfw: false,
            requestedIsNsfw: true,
            confirmationDomain: 'wrong.example',
            nodeDomain: 'node.example',
        })).toMatchObject({
            allowed: false,
            code: 'ADULT_ONLY_CONFIRMATION_REQUIRED',
            status: 400,
        });
    });

    it('accepts a trimmed, case-insensitive domain confirmation', () => {
        expect(matchesNodeDomainConfirmation(' NODE.EXAMPLE ', 'node.example')).toBe(true);
        expect(resolveNodeNsfwTransition({
            currentIsNsfw: false,
            requestedIsNsfw: true,
            confirmationDomain: ' NODE.EXAMPLE ',
            nodeDomain: 'node.example',
        })).toEqual({ allowed: true, isNsfw: true });
    });

    it('rejects every adult-only to general-audience transition', () => {
        expect(resolveNodeNsfwTransition({
            currentIsNsfw: true,
            requestedIsNsfw: false,
            confirmationDomain: 'node.example',
            nodeDomain: 'node.example',
        })).toMatchObject({
            allowed: false,
            code: 'ADULT_ONLY_CLASSIFICATION_PERMANENT',
            status: 409,
        });
    });

    it('allows idempotent saves after a node is already adult-only', () => {
        expect(resolveNodeNsfwTransition({
            currentIsNsfw: true,
            requestedIsNsfw: true,
            nodeDomain: 'node.example',
        })).toEqual({ allowed: true, isNsfw: true });
    });

    it('preserves the current classification when a settings update omits it', () => {
        expect(resolveNodeNsfwTransition({
            currentIsNsfw: true,
            requestedIsNsfw: undefined,
            nodeDomain: 'node.example',
        })).toEqual({ allowed: true, isNsfw: true });
    });

    it('rejects malformed classification values', () => {
        expect(resolveNodeNsfwTransition({
            currentIsNsfw: false,
            requestedIsNsfw: 'true',
            nodeDomain: 'node.example',
        })).toMatchObject({
            allowed: false,
            code: 'INVALID_NSFW_CLASSIFICATION',
            status: 400,
        });
    });

    it('does not let later swarm announcements downgrade an adult-only node', () => {
        expect(mergePermanentNodeNsfwClassification(true, false)).toBe(true);
        expect(mergePermanentNodeNsfwClassification(true, undefined)).toBe(true);
        expect(mergePermanentNodeNsfwClassification(false, true)).toBe(true);
        expect(mergePermanentNodeNsfwClassification(false, false)).toBe(false);
    });
});
