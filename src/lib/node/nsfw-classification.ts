interface NodeNsfwTransitionInput {
    currentIsNsfw: boolean;
    requestedIsNsfw: unknown;
    confirmationDomain?: unknown;
    nodeDomain: string;
}

type NodeNsfwTransitionResult =
    | { allowed: true; isNsfw: boolean }
    | { allowed: false; status: 400 | 409; code: string; error: string };

export function matchesNodeDomainConfirmation(confirmation: unknown, nodeDomain: string): boolean {
    return typeof confirmation === 'string'
        && confirmation.trim().toLowerCase() === nodeDomain.trim().toLowerCase();
}

export function mergePermanentNodeNsfwClassification(
    currentIsNsfw: boolean,
    incomingIsNsfw?: boolean,
): boolean {
    return currentIsNsfw || incomingIsNsfw === true;
}

export function resolveNodeNsfwTransition({
    currentIsNsfw,
    requestedIsNsfw,
    confirmationDomain,
    nodeDomain,
}: NodeNsfwTransitionInput): NodeNsfwTransitionResult {
    if (requestedIsNsfw !== undefined && typeof requestedIsNsfw !== 'boolean') {
        return {
            allowed: false,
            status: 400,
            code: 'INVALID_NSFW_CLASSIFICATION',
            error: 'The adult-only classification must be a boolean value.',
        };
    }

    if (requestedIsNsfw === undefined || requestedIsNsfw === currentIsNsfw) {
        return { allowed: true, isNsfw: currentIsNsfw };
    }

    if (currentIsNsfw) {
        return {
            allowed: false,
            status: 409,
            code: 'ADULT_ONLY_CLASSIFICATION_PERMANENT',
            error: 'This node is permanently classified as adult-only and cannot return to general-audience status.',
        };
    }

    if (!matchesNodeDomainConfirmation(confirmationDomain, nodeDomain)) {
        return {
            allowed: false,
            status: 400,
            code: 'ADULT_ONLY_CONFIRMATION_REQUIRED',
            error: `Type ${nodeDomain} to confirm the permanent adult-only classification.`,
        };
    }

    return { allowed: true, isNsfw: true };
}
